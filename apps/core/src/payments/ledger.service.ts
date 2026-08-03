import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Ledger-first: баланс — это SUM(ledger_entry.amount_kopeks), отдельного поля balance нет.
 * Записи append-only и никогда не правятся: так баланс не рассинхронизируется
 * и бесплатно получается история операций.
 */
@Injectable()
export class LedgerService {
  private readonly log = new Logger(LedgerService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  async getBalance(subscriberId: string): Promise<number> {
    const [row] = await this.db
      .select({ balance: sql<string>`coalesce(sum(${schema.ledgerEntry.amountKopeks}), 0)` })
      .from(schema.ledgerEntry)
      .where(
        and(eq(schema.ledgerEntry.orgId, this.cfg.defaultOrgId), eq(schema.ledgerEntry.subscriberId, subscriberId)),
      );
    return Number(row?.balance ?? 0);
  }

  /**
   * Фулфилмент оплаченного платежа — общий для всех провайдеров.
   * topup: только пополнение баланса.
   * plan:  пополнение + списание + продление подписки (в одной транзакции).
   */
  async fulfillPayment(tx: Tx, payment: typeof schema.payment.$inferSelect) {
    await this.append(tx, {
      subscriberId: payment.subscriberId,
      amountKopeks: payment.amountKopeks,
      entryType: "topup",
      paymentId: payment.id,
      description: `Оплата ${payment.provider}`,
      idempotencyKey: `topup:${payment.id}`,
    });

    if (payment.purpose === "topup") {
      await this.markFirstPaid(tx, payment);
      return { kind: "topup" as const };
    }

    const activation = await this.applyPlan(tx, payment);
    await this.markFirstPaid(tx, payment);
    return { kind: "plan" as const, ...activation };
  }

  /** Начисление реф-награды после антифрод-выдержки. Повтор гасится unique(idempotency_key). */
  async creditReferral(tx: Tx, input: { subscriberId: string; amountKopeks: number; rewardId: string }) {
    await this.append(tx, {
      subscriberId: input.subscriberId,
      amountKopeks: Math.abs(input.amountKopeks),
      entryType: "referral",
      description: "Реферальное вознаграждение",
      idempotencyKey: `referral:${input.rewardId}`,
    });
  }

  /** Списание с баланса за тариф (покупка без внешнего платежа). */
  async chargeBalance(tx: Tx, input: { subscriberId: string; amountKopeks: number; description: string; refId: string }) {
    await this.append(tx, {
      subscriberId: input.subscriberId,
      amountKopeks: -Math.abs(input.amountKopeks),
      entryType: "purchase",
      description: input.description,
      idempotencyKey: `purchase:${input.refId}`,
    });
  }

  /**
   * Продление подписки. Guard от лишних дней при повторном вебхуке —
   * UNIQUE(payment_id) на subscription_activation: вторая попытка просто ничего не сделает.
   */
  private async applyPlan(tx: Tx, payment: typeof schema.payment.$inferSelect) {
    if (!payment.planId) return { action: "none" as const };

    const [plan] = await tx.select().from(schema.plan).where(eq(schema.plan.id, payment.planId)).limit(1);
    if (!plan) return { action: "none" as const };

    // Порядок обязателен: у клиента бывает вторая подписка, и без сортировки
    // Postgres отдаёт произвольную строку — оплата продлевала бы не ту, что бот
    // показал клиенту. Тот же порядок в SubscribersService.findSubscription.
    const [subscription] = await tx
      .select()
      .from(schema.subscription)
      .where(
        and(
          eq(schema.subscription.orgId, payment.orgId),
          eq(schema.subscription.subscriberId, payment.subscriberId),
        ),
      )
      .orderBy(asc(schema.subscription.createdAt), asc(schema.subscription.id))
      .limit(1);
    if (!subscription) return { action: "none" as const };

    await this.append(tx, {
      subscriberId: payment.subscriberId,
      amountKopeks: -Math.abs(plan.priceKopeks),
      entryType: "purchase",
      paymentId: payment.id,
      subscriptionId: subscription.id,
      description: `Тариф ${plan.title}`,
      idempotencyKey: `purchase:${payment.id}`,
    });

    // продлеваем от текущей даты окончания, если она в будущем, иначе от сегодня
    const now = new Date();
    const base = subscription.expireAt && subscription.expireAt > now ? subscription.expireAt : now;
    const newExpireAt = new Date(base.getTime() + plan.periodDays * 86_400_000);
    const action = subscription.expireAt && subscription.expireAt > now ? "extended" : "created";

    const inserted = await tx
      .insert(schema.subscriptionActivation)
      .values({
        orgId: payment.orgId,
        subscriptionId: subscription.id,
        paymentId: payment.id,
        planId: plan.id,
        action,
        addedDays: plan.periodDays,
        newExpireAt,
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) {
      this.log.warn(`payment ${payment.id}: активация уже применена, лишние дни не начисляем`);
      return { action: "already_applied" as const };
    }

    await tx
      .update(schema.subscription)
      .set({
        status: "active",
        expireAt: newExpireAt,
        trafficLimitBytes: plan.trafficGb ? plan.trafficGb * 1024 ** 3 : subscription.trafficLimitBytes,
        hwidDeviceLimit: plan.deviceLimit ?? subscription.hwidDeviceLimit,
        updatedAt: now,
      })
      .where(eq(schema.subscription.id, subscription.id));

    await this.syncSquads(tx, subscription.id, plan.squadIds);

    return { action, newExpireAt, subscriptionId: subscription.id };
  }

  /**
   * Доступ подписки к нодам = членство в squad'ах тарифа.
   * Без этой синхронизации оплата не давала доступа вообще: подписка «активна»,
   * конфиг отдаётся, но uuid не попадал в desired-state ноды и Xray рвал хендшейк.
   * Лишние squad'ы снимаем — при смене тарифа доступ не должен накапливаться.
   */
  private async syncSquads(tx: Tx, subscriptionId: string, squadIds: string[]) {
    if (squadIds.length > 0) {
      await tx
        .insert(schema.subscriptionSquad)
        .values(squadIds.map((squadId) => ({ subscriptionId, squadId })))
        .onConflictDoNothing();
    }

    const existing = await tx
      .select()
      .from(schema.subscriptionSquad)
      .where(eq(schema.subscriptionSquad.subscriptionId, subscriptionId));

    const extra = existing.filter((row) => !squadIds.includes(row.squadId));
    for (const row of extra) {
      await tx
        .delete(schema.subscriptionSquad)
        .where(
          and(
            eq(schema.subscriptionSquad.subscriptionId, subscriptionId),
            eq(schema.subscriptionSquad.squadId, row.squadId),
          ),
        );
    }
  }

  /**
   * Пометка первой оплаты подписчика (нужна для атрибуции рекламы).
   *
   * Нельзя «пометить и поймать конфликт»: в Postgres нарушение partial unique
   * обрывает ВСЮ транзакцию, а JS-catch внутри неё бесполезен — последующие
   * запросы падают, и фулфилмент второго платежа откатывался целиком
   * (деньги приняты, дней нет, платёж навсегда pending).
   * Поэтому условие «первой оплаты ещё нет» проверяется внутри самого UPDATE —
   * конфликт не возникает вовсе.
   */
  private async markFirstPaid(tx: Tx, payment: typeof schema.payment.$inferSelect) {
    await tx
      .update(schema.payment)
      .set({ isFirstPaid: true })
      .where(
        and(
          eq(schema.payment.id, payment.id),
          eq(schema.payment.isFirstPaid, false),
          sql`not exists (
            select 1 from ${schema.payment} p2
            where p2.subscriber_id = ${payment.subscriberId} and p2.is_first_paid
          )`,
        ),
      );
  }

  private async append(
    tx: Tx,
    entry: {
      subscriberId: string;
      amountKopeks: number;
      entryType: string;
      paymentId?: string;
      subscriptionId?: string;
      description?: string;
      idempotencyKey: string;
    },
  ) {
    await tx
      .insert(schema.ledgerEntry)
      .values({
        orgId: this.cfg.defaultOrgId,
        subscriberId: entry.subscriberId,
        amountKopeks: entry.amountKopeks,
        entryType: entry.entryType,
        paymentId: entry.paymentId,
        subscriptionId: entry.subscriptionId,
        description: entry.description,
        idempotencyKey: entry.idempotencyKey,
      })
      .onConflictDoNothing(); // повтор по idempotency_key — не ошибка, а «уже записано»
  }
}

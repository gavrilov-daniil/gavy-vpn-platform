import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
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

    const [subscription] = await tx
      .select()
      .from(schema.subscription)
      .where(
        and(
          eq(schema.subscription.orgId, payment.orgId),
          eq(schema.subscription.subscriberId, payment.subscriberId),
        ),
      )
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

    return { action, newExpireAt, subscriptionId: subscription.id };
  }

  /** Пометка первой оплаты — partial unique index не даст пометить дважды. */
  private async markFirstPaid(tx: Tx, payment: typeof schema.payment.$inferSelect) {
    try {
      await tx
        .update(schema.payment)
        .set({ isFirstPaid: true })
        .where(and(eq(schema.payment.id, payment.id), eq(schema.payment.isFirstPaid, false)));
    } catch {
      // нарушение partial unique = у подписчика уже есть первая оплата, это штатная ветка
    }
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

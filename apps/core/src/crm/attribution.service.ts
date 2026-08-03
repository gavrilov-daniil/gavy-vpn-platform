import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

/** Crockford-подобный алфавит без 0/O/1/I: код с рекламы набирают руками. */
export const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const LINK_CODE_RE = /^[A-HJ-NP-Z2-9]{4,6}$/;

@Injectable()
export class AttributionService {
  private readonly log = new Logger(AttributionService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * payload из t.me/bot?start=c_<CODE>.
   * Невалидный или неизвестный код — не ошибка: юзер просто считается органикой.
   */
  async resolveStartPayload(payload?: string | null) {
    if (!payload || !payload.startsWith("c_")) return null;
    const code = payload.slice(2).toUpperCase();
    if (!LINK_CODE_RE.test(code)) return null;

    const rows = await this.db
      .select()
      .from(schema.campaignLink)
      .where(
        and(
          eq(schema.campaignLink.orgId, this.cfg.defaultOrgId),
          eq(schema.campaignLink.code, code),
          eq(schema.campaignLink.isArchived, false),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * First-touch: subscriber.campaign_link_id пишется только пока он NULL.
   * Приход по другой ссылке позже даёт событие с meta.revisit и не крутит счётчик.
   */
  async onRegistration(subscriberId: string, campaignLinkId: string) {
    return this.db.transaction(async (tx) => {
      const claimed = await tx
        .update(schema.subscriber)
        .set({ campaignLinkId })
        .where(
          and(
            eq(schema.subscriber.orgId, this.cfg.defaultOrgId),
            eq(schema.subscriber.id, subscriberId),
            isNull(schema.subscriber.campaignLinkId),
          ),
        )
        .returning();
      const firstTouch = claimed.length > 0;

      const inserted = await tx
        .insert(schema.campaignEvent)
        .values({
          orgId: this.cfg.defaultOrgId,
          campaignLinkId,
          subscriberId,
          type: "registration",
          meta: firstTouch ? {} : { revisit: true },
        })
        .onConflictDoNothing()
        .returning();

      if (inserted.length === 0) {
        return { counted: false as const, firstTouch, reason: "already_registered" as const };
      }
      if (!firstTouch) return { counted: false as const, firstTouch, reason: "revisit" as const };

      await tx
        .update(schema.campaignLink)
        .set({ registrations: sql`${schema.campaignLink.registrations} + 1` })
        .where(eq(schema.campaignLink.id, campaignLinkId));

      return { counted: true as const, firstTouch, eventId: inserted[0].id };
    });
  }

  /**
   * payment.campaign_link_id проставляет триггер trg_payment_set_campaign_link,
   * поэтому здесь только читаем снимок и разносим его по счётчикам ссылки.
   */
  async onPaymentPaid(paymentId: string) {
    const [payment] = await this.db
      .select()
      .from(schema.payment)
      .where(and(eq(schema.payment.orgId, this.cfg.defaultOrgId), eq(schema.payment.id, paymentId)))
      .limit(1);

    if (!payment) return { counted: false as const, reason: "payment_not_found" as const };
    if (payment.status !== "paid") return { counted: false as const, reason: "not_paid" as const };
    if (!payment.campaignLinkId) return { counted: false as const, reason: "organic" as const };
    const campaignLinkId = payment.campaignLinkId;

    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.campaignEvent)
        .values({
          orgId: this.cfg.defaultOrgId,
          campaignLinkId,
          subscriberId: payment.subscriberId,
          paymentId: payment.id,
          type: "payment",
          meta: { amountKopeks: payment.amountKopeks, provider: payment.provider },
        })
        .onConflictDoNothing()
        .returning();

      if (inserted.length === 0) {
        this.log.warn(`payment ${paymentId}: атрибуция уже учтена`);
        return { counted: false as const, reason: "already_counted" as const };
      }

      // paying_users — уникальные плательщики. Считаем по флагу первой оплаты, который
      // проставляется под partial unique payment_first_paid_uq: у подписчика он есть ровно
      // у одного платежа, поэтому два параллельных первых платежа дают +1, а не +2.
      // Подсчёт прошлых событий этого не давал: оба видели «прошлых нет» до блокировки строки.
      const isNewPayer = payment.isFirstPaid;

      await tx
        .update(schema.campaignLink)
        .set({
          revenueKopeks: sql`${schema.campaignLink.revenueKopeks} + ${payment.amountKopeks}`,
          payingUsers: isNewPayer
            ? sql`${schema.campaignLink.payingUsers} + 1`
            : sql`${schema.campaignLink.payingUsers}`,
        })
        .where(eq(schema.campaignLink.id, campaignLinkId));

      return { counted: true as const, isNewPayer, eventId: inserted[0].id };
    });
  }
}

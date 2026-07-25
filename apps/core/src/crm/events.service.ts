import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

export interface TrackInput {
  telegramUserId?: number | null;
  subscriberId?: string | null;
  event: string;
  updateId?: number | null;
  payload?: Record<string, unknown>;
}

/** Этапы воронки из bot_event. Платёжные этапы считаются по таблице payment. */
const BOT_STAGES = ["start", "plans_open", "plan_selected", "pay_method_open"] as const;

@Injectable()
export class EventsService {
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  /** Дедуп по update_id: повторная доставка вебхука Telegram не раздувает воронку. */
  async track(input: TrackInput) {
    const inserted = await this.db
      .insert(schema.botEvent)
      .values({
        orgId: this.cfg.defaultOrgId,
        telegramUserId: input.telegramUserId ?? undefined,
        subscriberId: input.subscriberId ?? undefined,
        event: input.event,
        updateId: input.updateId ?? undefined,
        payload: input.payload ?? {},
      })
      .onConflictDoNothing()
      .returning();

    return inserted.length > 0
      ? { tracked: true as const, id: inserted[0].id }
      : { tracked: false as const, reason: "duplicate_update_id" as const };
  }

  /** Агрегаты воронки за период: этапы + разбивка по дням. Источник — bot_event + payment. */
  async funnel(days = 30) {
    const from = new Date(Date.now() - days * 86_400_000);

    const botStages = await this.db
      .select({
        event: schema.botEvent.event,
        users: sql<string>`count(distinct ${schema.botEvent.telegramUserId})`,
        events: sql<string>`count(*)`,
      })
      .from(schema.botEvent)
      .where(
        and(
          eq(schema.botEvent.orgId, this.cfg.defaultOrgId),
          inArray(schema.botEvent.event, [...BOT_STAGES]),
          gte(schema.botEvent.createdAt, from),
        ),
      )
      .groupBy(schema.botEvent.event);

    const [created] = await this.db
      .select({
        users: sql<string>`count(distinct ${schema.payment.subscriberId})`,
        events: sql<string>`count(*)`,
      })
      .from(schema.payment)
      .where(and(eq(schema.payment.orgId, this.cfg.defaultOrgId), gte(schema.payment.createdAt, from)));

    const [paid] = await this.db
      .select({
        users: sql<string>`count(distinct ${schema.payment.subscriberId})`,
        events: sql<string>`count(*)`,
        revenue: sql<string>`coalesce(sum(${schema.payment.amountKopeks}), 0)`,
      })
      .from(schema.payment)
      .where(
        and(
          eq(schema.payment.orgId, this.cfg.defaultOrgId),
          eq(schema.payment.status, "paid"),
          gte(schema.payment.createdAt, from),
        ),
      );

    const byEvent = new Map(botStages.map((r) => [r.event, r]));
    const stages = [
      ...BOT_STAGES.map((key) => ({
        key,
        users: Number(byEvent.get(key)?.users ?? 0),
        events: Number(byEvent.get(key)?.events ?? 0),
      })),
      { key: "payment_created", users: Number(created?.users ?? 0), events: Number(created?.events ?? 0) },
      { key: "payment_paid", users: Number(paid?.users ?? 0), events: Number(paid?.events ?? 0) },
    ];

    const daily = await this.daily(from);
    const startUsers = stages[0].users;
    const paidUsers = stages[stages.length - 1].users;

    return {
      from,
      days,
      stages,
      revenueKopeks: Number(paid?.revenue ?? 0),
      startToPaid: startUsers > 0 ? Number((paidUsers / startUsers).toFixed(4)) : 0,
      daily,
    };
  }

  private async daily(from: Date) {
    const newSubscribers = await this.db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${schema.subscriber.createdAt}), 'YYYY-MM-DD')`,
        count: sql<string>`count(*)`,
      })
      .from(schema.subscriber)
      .where(and(eq(schema.subscriber.orgId, this.cfg.defaultOrgId), gte(schema.subscriber.createdAt, from)))
      .groupBy(sql`date_trunc('day', ${schema.subscriber.createdAt})`);

    const payments = await this.db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${schema.payment.paidAt}), 'YYYY-MM-DD')`,
        count: sql<string>`count(*)`,
        revenue: sql<string>`coalesce(sum(${schema.payment.amountKopeks}), 0)`,
      })
      .from(schema.payment)
      .where(
        and(
          eq(schema.payment.orgId, this.cfg.defaultOrgId),
          eq(schema.payment.status, "paid"),
          gte(schema.payment.paidAt, from),
        ),
      )
      .groupBy(sql`date_trunc('day', ${schema.payment.paidAt})`);

    const days = new Map<string, { date: string; newSubscribers: number; payments: number; revenueKopeks: number }>();
    const row = (date: string) => {
      const existing = days.get(date);
      if (existing) return existing;
      const fresh = { date, newSubscribers: 0, payments: 0, revenueKopeks: 0 };
      days.set(date, fresh);
      return fresh;
    };

    for (const r of newSubscribers) row(r.day).newSubscribers = Number(r.count);
    for (const r of payments) {
      const day = row(r.day);
      day.payments = Number(r.count);
      day.revenueKopeks = Number(r.revenue);
    }

    return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}

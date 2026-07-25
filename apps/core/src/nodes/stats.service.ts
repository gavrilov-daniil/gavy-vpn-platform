import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

export interface StatsDelta {
  subjectType: "user" | "inbound" | "outbound";
  subjectKey: string;
  upDelta: number;
  downDelta: number;
  windowStart: string;
  windowEnd: string;
}

export interface StatsBatch {
  /** Монотонный идентификатор батча вида "<agent_epoch>:<seq>" — дедуп повторной доставки. */
  reportId: string;
  deltas: StatsDelta[];
}

/**
 * Приём статистики. Ledger-first, как деньги: сырьё append-only, агрегаты считаются.
 * Счётчик трафика подписчика нигде не правится напрямую.
 *
 * Трафик — метрика, а не деньги: при переналивке ноды дельта может потеряться,
 * и это осознанно принимается (exact-once тут не строим). Но задвоение недопустимо,
 * поэтому два барьера: дедуп батча по report_id и дедуп дельты по окну.
 */
@Injectable()
export class StatsService {
  private readonly log = new Logger(StatsService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  async ingest(nodeId: string, batch: StatsBatch) {
    // Барьер 1: батч целиком. Повторная доставка того же report_id — no-op.
    const inserted = await this.db
      .insert(schema.trafficReport)
      .values({
        orgId: this.cfg.defaultOrgId,
        nodeId,
        reportId: batch.reportId,
        raw: { count: batch.deltas.length },
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) {
      this.log.warn(`node ${nodeId}: батч ${batch.reportId} уже принят, пропускаем`);
      return { accepted: false, applied: 0 };
    }

    if (batch.deltas.length === 0) return { accepted: true, applied: 0 };

    // Барьер 2: отдельная дельта. UNIQUE(node, subject, window_start).
    const rows = batch.deltas.map((d) => ({
      orgId: this.cfg.defaultOrgId,
      nodeId,
      subjectType: d.subjectType,
      subjectKey: d.subjectKey,
      upDelta: Math.max(0, Math.trunc(d.upDelta)),
      downDelta: Math.max(0, Math.trunc(d.downDelta)),
      windowStart: new Date(d.windowStart),
      windowEnd: new Date(d.windowEnd),
    }));

    const applied = await this.db.insert(schema.trafficSample).values(rows).onConflictDoNothing().returning();

    await this.rollupDaily(nodeId, applied);
    await this.applyUserUsage(applied);

    return { accepted: true, applied: applied.length };
  }

  /** Суточный агрегат — пересчитывается из сырья, руками не правится. */
  private async rollupDaily(nodeId: string, samples: Array<typeof schema.trafficSample.$inferSelect>) {
    for (const s of samples) {
      const day = s.windowStart.toISOString().slice(0, 10);
      await this.db
        .insert(schema.trafficDaily)
        .values({
          orgId: this.cfg.defaultOrgId,
          day,
          subjectType: s.subjectType,
          subjectKey: s.subjectKey,
          nodeId,
          up: s.upDelta,
          down: s.downDelta,
        })
        .onConflictDoUpdate({
          target: [
            schema.trafficDaily.orgId,
            schema.trafficDaily.day,
            schema.trafficDaily.subjectType,
            schema.trafficDaily.subjectKey,
            schema.trafficDaily.nodeId,
          ],
          set: {
            up: sql`${schema.trafficDaily.up} + ${s.upDelta}`,
            down: sql`${schema.trafficDaily.down} + ${s.downDelta}`,
          },
        });
    }
  }

  /**
   * Кэш-счётчик подписки. Истина — в traffic_sample; это денормализация для UI и лимитов.
   * subject_key для пользователя = short_uuid (email в Xray).
   */
  private async applyUserUsage(samples: Array<typeof schema.trafficSample.$inferSelect>) {
    const perUser = new Map<string, number>();
    for (const s of samples) {
      if (s.subjectType !== "user") continue;
      perUser.set(s.subjectKey, (perUser.get(s.subjectKey) ?? 0) + s.upDelta + s.downDelta);
    }

    for (const [shortUuid, bytes] of perUser) {
      await this.db
        .update(schema.subscription)
        .set({
          usedTrafficBytes: sql`${schema.subscription.usedTrafficBytes} + ${bytes}`,
          lifetimeUsedBytes: sql`${schema.subscription.lifetimeUsedBytes} + ${bytes}`,
          onlineAt: new Date(),
        })
        .where(
          and(
            eq(schema.subscription.orgId, this.cfg.defaultOrgId),
            eq(schema.subscription.shortUuid, shortUuid),
          ),
        );
    }
  }

  /** Сводка по подписчику: сколько израсходовано и с каких нод. */
  async usageBySubscription(shortUuid: string) {
    const rows = await this.db
      .select({
        nodeId: schema.trafficDaily.nodeId,
        day: schema.trafficDaily.day,
        up: schema.trafficDaily.up,
        down: schema.trafficDaily.down,
      })
      .from(schema.trafficDaily)
      .where(
        and(
          eq(schema.trafficDaily.orgId, this.cfg.defaultOrgId),
          eq(schema.trafficDaily.subjectType, "user"),
          eq(schema.trafficDaily.subjectKey, shortUuid),
        ),
      );
    return rows;
  }
}

import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
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

  /**
   * Сводные разрезы для админки.
   *
   * Про устройства важное ограничение, из-за которого разрез «трафик по устройству»
   * тут отсутствует и не появится: Xray считает трафик по email пользователя, а email —
   * это `short_uuid` подписки. Все устройства одного клиента ходят под одним `vless_uuid`,
   * поэтому байты между ними неразделимы в принципе. Выдать каждому устройству свой uuid
   * нельзя: идентичность обязана переноситься с панели дословно (docs/migration.md, P0-3).
   * Поэтому по устройствам и платформам отдаём СОСТАВ парка, а байты — по пользователю и ноде.
   */
  async overview(days = 30) {
    const since = dayKey(days);

    const [totals, byDay, byNode, platforms, devices] = await Promise.all([
      this.db
        .select({
          up: sql<number>`coalesce(sum(${schema.trafficDaily.up}), 0)::bigint`,
          down: sql<number>`coalesce(sum(${schema.trafficDaily.down}), 0)::bigint`,
          subscribers: sql<number>`count(distinct ${schema.trafficDaily.subjectKey})::int`,
        })
        .from(schema.trafficDaily)
        .where(this.userScope(since)),

      this.db
        .select({
          day: schema.trafficDaily.day,
          up: sql<number>`sum(${schema.trafficDaily.up})::bigint`,
          down: sql<number>`sum(${schema.trafficDaily.down})::bigint`,
        })
        .from(schema.trafficDaily)
        .where(this.userScope(since))
        .groupBy(schema.trafficDaily.day)
        .orderBy(schema.trafficDaily.day),

      this.db
        .select({
          nodeId: schema.node.id,
          nodeName: schema.node.name,
          country: schema.server.country,
          up: sql<number>`sum(${schema.trafficDaily.up})::bigint`,
          down: sql<number>`sum(${schema.trafficDaily.down})::bigint`,
        })
        .from(schema.trafficDaily)
        .innerJoin(schema.node, eq(schema.node.id, schema.trafficDaily.nodeId))
        .innerJoin(schema.server, eq(schema.server.id, schema.node.serverId))
        .where(this.userScope(since))
        .groupBy(schema.node.id, schema.node.name, schema.server.country)
        .orderBy(sql`sum(${schema.trafficDaily.up} + ${schema.trafficDaily.down}) desc`),

      this.db
        .select({
          // null остаётся отдельной категорией: клиент без x-hwid — это не «прочее», а
          // приложение, которое заголовок не шлёт, и таких надо видеть отдельно
          os: schema.subscriberDevice.deviceOs,
          devices: sql<number>`count(*)::int`,
          subscriptions: sql<number>`count(distinct ${schema.subscriberDevice.subscriptionId})::int`,
        })
        .from(schema.subscriberDevice)
        .where(eq(schema.subscriberDevice.orgId, this.cfg.defaultOrgId))
        .groupBy(schema.subscriberDevice.deviceOs)
        .orderBy(sql`count(*) desc`),

      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.subscriberDevice)
        .where(eq(schema.subscriberDevice.orgId, this.cfg.defaultOrgId)),
    ]);

    return {
      periodDays: days,
      traffic: { ...(totals[0] ?? { up: 0, down: 0, subscribers: 0 }), byDay, byNode },
      // Трафик здесь намеренно отсутствует — см. комментарий выше
      devices: { total: devices[0]?.total ?? 0, byPlatform: platforms },
    };
  }

  /** Кто расходует больше всех. subject_key = short_uuid, поэтому подписка находится напрямую. */
  async topSubscribers(days = 30, limit = 50) {
    const since = dayKey(days);

    return this.db
      .select({
        shortUuid: schema.trafficDaily.subjectKey,
        subscriptionId: schema.subscription.id,
        status: schema.subscription.status,
        telegramId: schema.subscriber.telegramId,
        up: sql<number>`sum(${schema.trafficDaily.up})::bigint`,
        down: sql<number>`sum(${schema.trafficDaily.down})::bigint`,
      })
      .from(schema.trafficDaily)
      // left, а не inner: трафик удалённой подписки — это не повод потерять его из сводки
      .leftJoin(schema.subscription, eq(schema.subscription.shortUuid, schema.trafficDaily.subjectKey))
      .leftJoin(schema.subscriber, eq(schema.subscriber.id, schema.subscription.subscriberId))
      .where(this.userScope(since))
      .groupBy(
        schema.trafficDaily.subjectKey,
        schema.subscription.id,
        schema.subscription.status,
        schema.subscriber.telegramId,
      )
      .orderBy(sql`sum(${schema.trafficDaily.up} + ${schema.trafficDaily.down}) desc`)
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  /** Устройства подписки: что именно подключалось и когда последний раз. */
  async devicesBySubscription(shortUuid: string) {
    return this.db
      .select({
        hwid: schema.subscriberDevice.hwid,
        deviceOs: schema.subscriberDevice.deviceOs,
        osVer: schema.subscriberDevice.osVer,
        deviceModel: schema.subscriberDevice.deviceModel,
        firstSeenAt: schema.subscriberDevice.firstSeenAt,
        lastSeenAt: schema.subscriberDevice.lastSeenAt,
      })
      .from(schema.subscriberDevice)
      .innerJoin(schema.subscription, eq(schema.subscription.id, schema.subscriberDevice.subscriptionId))
      .where(
        and(
          eq(schema.subscriberDevice.orgId, this.cfg.defaultOrgId),
          eq(schema.subscription.shortUuid, shortUuid),
        ),
      )
      .orderBy(sql`${schema.subscriberDevice.lastSeenAt} desc`);
  }

  private userScope(since: string) {
    return and(
      eq(schema.trafficDaily.orgId, this.cfg.defaultOrgId),
      // только subject_type=user: inbound и outbound считают тот же трафик второй раз,
      // и суммирование по всем типам завысило бы итог кратно
      eq(schema.trafficDaily.subjectType, "user"),
      gte(schema.trafficDaily.day, since),
    );
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

/** Нижняя граница периода в формате колонки `day` (YYYY-MM-DD): сравнение идёт по тексту. */
function dayKey(days: number): string {
  const from = new Date(Date.now() - Math.max(days, 1) * 86_400_000);
  return from.toISOString().slice(0, 10);
}

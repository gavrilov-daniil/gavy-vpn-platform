import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

export interface AbusePolicy {
  /** Порог объёма за окно, байт. Выше — подозрение на майнинг/раздачу. */
  volumeBytesPerWindow: number;
  /** Доля upload в общем трафике, выше которой это похоже на сидирование торрентов. */
  seedingRatio: number;
  /** Сколько разных IP на одну подписку считаем шарингом аккаунта. */
  ipFanout: number;
  windowHours: number;
}

const DEFAULT_POLICY: AbusePolicy = {
  volumeBytesPerWindow: 200 * 1024 ** 3, // 200 ГБ за окно
  seedingRatio: 0.75,
  ipFanout: 8,
  windowHours: 24,
};

/**
 * Анти-абьюз. Разделение ответственности намеренное:
 *   Xray на ноде  — дешёвый барьер конфигом (bittorrent и SMTP в block);
 *   здесь         — детект по накопленной статистике и решение;
 *   node-agent    — исполнение (throttle/бан IP).
 *
 * Детект строится на traffic_sample, потому что это единственные данные,
 * которые у нас реально есть: Xray не сообщает «это торрент», он сообщает байты.
 */
@Injectable()
export class AbuseService {
  private readonly log = new Logger(AbuseService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  async scan(policy: Partial<AbusePolicy> = {}) {
    const p = { ...DEFAULT_POLICY, ...policy };
    const since = new Date(Date.now() - p.windowHours * 3600_000);

    const usage = await this.db
      .select({
        subjectKey: schema.trafficSample.subjectKey,
        up: sql<string>`sum(${schema.trafficSample.upDelta})`,
        down: sql<string>`sum(${schema.trafficSample.downDelta})`,
      })
      .from(schema.trafficSample)
      .where(
        and(
          eq(schema.trafficSample.orgId, this.cfg.defaultOrgId),
          eq(schema.trafficSample.subjectType, "user"),
          gte(schema.trafficSample.windowStart, since),
        ),
      )
      .groupBy(schema.trafficSample.subjectKey);

    const signals: Array<{ shortUuid: string; kind: string; severity: number; evidence: Record<string, unknown> }> = [];

    for (const row of usage) {
      const up = Number(row.up ?? 0);
      const down = Number(row.down ?? 0);
      const total = up + down;

      if (total > p.volumeBytesPerWindow) {
        signals.push({
          shortUuid: row.subjectKey,
          kind: "volume",
          severity: total > p.volumeBytesPerWindow * 3 ? 3 : 2,
          evidence: { totalBytes: total, windowHours: p.windowHours },
        });
      }
      // upload сильно больше download — типичный признак раздачи, а не потребления
      if (total > 5 * 1024 ** 3 && up / total > p.seedingRatio) {
        signals.push({
          shortUuid: row.subjectKey,
          kind: "seeding",
          severity: 2,
          evidence: { upBytes: up, downBytes: down, ratio: Number((up / total).toFixed(2)) },
        });
      }
    }

    // шаринг аккаунта: одна подписка светится с многих адресов
    const fanout = await this.db
      .select({ subscriptionId: schema.onlineState.subscriptionId, ipCount: schema.onlineState.ipCount })
      .from(schema.onlineState)
      .where(gte(schema.onlineState.ipCount, p.ipFanout));

    for (const row of fanout) {
      const [sub] = await this.db
        .select()
        .from(schema.subscription)
        .where(eq(schema.subscription.id, row.subscriptionId))
        .limit(1);
      if (!sub) continue;
      signals.push({
        shortUuid: sub.shortUuid,
        kind: "ip_fanout",
        severity: 3,
        evidence: { ipCount: row.ipCount, threshold: p.ipFanout },
      });
    }

    return this.persist(signals);
  }

  /**
   * Действие идемпотентно по ключу kind:subscription:дата — сработавший трижды
   * за сутки детект даёт одно действие, а не три подряд наказания.
   */
  private async persist(
    signals: Array<{ shortUuid: string; kind: string; severity: number; evidence: Record<string, unknown> }>,
  ) {
    let created = 0;
    let actions = 0;

    for (const s of signals) {
      const [sub] = await this.db
        .select()
        .from(schema.subscription)
        .where(
          and(
            eq(schema.subscription.orgId, this.cfg.defaultOrgId),
            eq(schema.subscription.shortUuid, s.shortUuid),
          ),
        )
        .limit(1);
      if (!sub) continue;

      await this.db.insert(schema.abuseSignal).values({
        orgId: this.cfg.defaultOrgId,
        subscriptionId: sub.id,
        kind: s.kind,
        severity: s.severity,
        evidence: s.evidence,
      });
      created++;

      const action = s.severity >= 3 ? "suspend" : "warn";
      const bucket = new Date().toISOString().slice(0, 10);
      const inserted = await this.db
        .insert(schema.abuseAction)
        .values({
          orgId: this.cfg.defaultOrgId,
          subscriptionId: sub.id,
          action,
          reason: `${s.kind}: ${JSON.stringify(s.evidence)}`,
          idempotencyKey: `${s.kind}:${sub.id}:${bucket}`,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted.length === 0) continue;
      actions++;

      // suspend снимает юзера с нод при следующей пересборке desired-state
      if (action === "suspend") {
        await this.db
          .update(schema.subscription)
          .set({ status: "suspended", updatedAt: new Date() })
          .where(eq(schema.subscription.id, sub.id));
        this.log.warn(`подписка ${sub.shortUuid} приостановлена: ${s.kind}`);
      }
    }

    return { signals: created, actions };
  }

  async listSignals(limit = 100) {
    return this.db
      .select()
      .from(schema.abuseSignal)
      .where(eq(schema.abuseSignal.orgId, this.cfg.defaultOrgId))
      .orderBy(sql`${schema.abuseSignal.detectedAt} desc`)
      .limit(limit);
  }

  async listActions(limit = 100) {
    return this.db
      .select()
      .from(schema.abuseAction)
      .where(eq(schema.abuseAction.orgId, this.cfg.defaultOrgId))
      .orderBy(sql`${schema.abuseAction.appliedAt} desc`)
      .limit(limit);
  }

  /** Снятие наказания вручную из админки. */
  async release(subscriptionId: string) {
    await this.db
      .update(schema.subscription)
      .set({ status: "active", updatedAt: new Date() })
      .where(
        and(
          eq(schema.subscription.orgId, this.cfg.defaultOrgId),
          eq(schema.subscription.id, subscriptionId),
        ),
      );
    return { ok: true };
  }
}

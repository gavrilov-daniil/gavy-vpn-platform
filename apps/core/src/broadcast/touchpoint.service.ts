import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, gte, isNotNull, lte, sql, type SQL } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { DispatchService } from "./dispatch.service.js";

export const TRIGGER_KEYS = ["trial_no_payment", "expires_soon", "expired_recently"] as const;
export type TriggerKey = (typeof TRIGGER_KEYS)[number];

/**
 * Окно попадания в триггер. Без него условие «триал старше N часов» держится вечно
 * и цель попадала бы в выборку бесконечно. Окно ограничивает выборку, а от повторной
 * отправки защищает dedup_key (см. anchorSql).
 */
const WINDOW_HOURS = 24;
const SEND_PAUSE_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class TouchpointService {
  private readonly log = new Logger(TouchpointService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly dispatch: DispatchService,
  ) {}

  async list() {
    return this.db
      .select()
      .from(schema.touchpoint)
      .where(eq(schema.touchpoint.orgId, this.cfg.defaultOrgId))
      .orderBy(schema.touchpoint.createdAt);
  }

  async create(input: {
    name: string;
    triggerKey: string;
    triggerType?: string;
    delayHours?: number;
    bodyHtml: string;
    buttons?: Record<string, unknown>[];
    quietHours?: { from: number; to: number } | null;
    isActive?: boolean;
  }) {
    const [row] = await this.db
      .insert(schema.touchpoint)
      .values({
        orgId: this.cfg.defaultOrgId,
        name: input.name,
        triggerType: input.triggerType ?? "condition",
        triggerKey: input.triggerKey,
        delayHours: input.delayHours ?? 0,
        bodyHtml: input.bodyHtml,
        buttons: input.buttons ?? [],
        quietHours: input.quietHours ?? undefined,
        isActive: input.isActive ?? true,
      })
      .returning();
    return row;
  }

  async update(
    id: string,
    patch: {
      name?: string;
      triggerKey?: string;
      triggerType?: string;
      delayHours?: number;
      bodyHtml?: string;
      buttons?: Record<string, unknown>[];
      quietHours?: { from: number; to: number } | null;
      isActive?: boolean;
    },
  ) {
    const values: Record<string, unknown> = {};
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.triggerKey !== undefined) values.triggerKey = patch.triggerKey;
    if (patch.triggerType !== undefined) values.triggerType = patch.triggerType;
    if (patch.delayHours !== undefined) values.delayHours = patch.delayHours;
    if (patch.bodyHtml !== undefined) values.bodyHtml = patch.bodyHtml;
    if (patch.buttons !== undefined) values.buttons = patch.buttons;
    if (patch.quietHours !== undefined) values.quietHours = patch.quietHours;
    if (patch.isActive !== undefined) values.isActive = patch.isActive;

    const [row] = await this.db
      .update(schema.touchpoint)
      .set(values)
      .where(and(eq(schema.touchpoint.orgId, this.cfg.defaultOrgId), eq(schema.touchpoint.id, id)))
      .returning();
    if (!row) throw new NotFoundException(`касание ${id} не найдено`);
    return row;
  }

  /** Вызывается по расписанию (раз в час). Дедуп — якорь самого триггера в dedup_key. */
  async runTouchpoints() {
    const rows = await this.db
      .select()
      .from(schema.touchpoint)
      .where(and(eq(schema.touchpoint.orgId, this.cfg.defaultOrgId), eq(schema.touchpoint.isActive, true)));

    const results = [];
    for (const tp of rows) results.push(await this.runOne(tp));
    return { touchpoints: results };
  }

  private async runOne(tp: typeof schema.touchpoint.$inferSelect) {
    if (inQuietHours(tp.quietHours)) {
      return { id: tp.id, name: tp.name, skipped: "quiet_hours" as const };
    }

    const targets = await this.findTargets(tp);
    const counts = { targets: targets.length, sent: 0, duplicate: 0, failed: 0 };

    for (const target of targets) {
      const result = await this.dispatch.send({
        subscriberId: target.subscriberId,
        telegramId: target.telegramId,
        kind: "touchpoint",
        refId: tp.id,
        dedupKey: `touchpoint:${tp.id}:${target.subscriberId}:${target.anchor}`,
        bodyHtml: tp.bodyHtml,
        buttons: tp.buttons,
      });

      if (result.outcome === "sent") counts.sent++;
      else if (result.outcome === "duplicate") counts.duplicate++;
      else counts.failed++;

      await sleep(SEND_PAUSE_MS);
    }

    this.log.log(`touchpoint ${tp.triggerKey} (${tp.id}): ${JSON.stringify(counts)}`);
    return { id: tp.id, name: tp.name, ...counts };
  }

  private async findTargets(tp: typeof schema.touchpoint.$inferSelect) {
    const filters = this.triggerFilters(tp);
    if (!filters) {
      this.log.warn(`touchpoint ${tp.id}: неизвестный trigger_key ${tp.triggerKey}, пропущен`);
      return [];
    }

    const rows = await this.db
      .selectDistinct({
        subscriberId: schema.subscriber.id,
        telegramId: schema.subscriber.telegramId,
        anchor: this.anchorSql(tp.triggerKey as TriggerKey),
      })
      .from(schema.subscriber)
      .leftJoin(schema.subscription, eq(schema.subscription.subscriberId, schema.subscriber.id))
      .where(
        and(
          eq(schema.subscriber.orgId, this.cfg.defaultOrgId),
          isNotNull(schema.subscriber.telegramId),
          eq(schema.subscriber.marketingOptOut, false),
          eq(schema.subscriber.tgBlocked, false),
          ...filters,
        ),
      );

    return rows
      .filter((r): r is { subscriberId: string; telegramId: number; anchor: string } => r.telegramId !== null)
      .map((r) => ({ subscriberId: r.subscriberId, telegramId: r.telegramId, anchor: r.anchor }));
  }

  /**
   * Bucket дедупа — «якорь» самого триггера, а не календарная дата. С датой окно в 24ч,
   * пересекающее полночь UTC, попадало в выборку в двух разных днях и давало два ключа,
   * то есть два сообщения одному человеку на каждое касание.
   * Якорь неизменен внутри одного цикла и меняется на следующем, поэтому:
   *   trial_no_payment — ровно один раз (trial_used_at ставится однажды и не переписывается);
   *   expires_soon / expired_recently — один раз на каждый expire_at, то есть касание
   *   штатно повторяется после продления и не повторяется в пределах одного срока.
   */
  private anchorSql(triggerKey: TriggerKey): SQL<string> {
    const column =
      triggerKey === "trial_no_payment" ? schema.subscriber.trialUsedAt : schema.subscription.expireAt;
    return sql<string>`coalesce(extract(epoch from ${column})::bigint::text, 'none')`;
  }

  private triggerFilters(tp: typeof schema.touchpoint.$inferSelect): SQL[] | null {
    const now = Date.now();
    const offset = tp.delayHours * 3_600_000;
    const window = WINDOW_HOURS * 3_600_000;

    switch (tp.triggerKey as TriggerKey) {
      case "trial_no_payment":
        return [
          gte(schema.subscriber.trialUsedAt, new Date(now - offset - window)),
          lte(schema.subscriber.trialUsedAt, new Date(now - offset)),
          sql`not exists (select 1 from ${schema.payment} where ${schema.payment.subscriberId} = ${schema.subscriber.id} and ${schema.payment.status} = 'paid')`,
        ];
      case "expires_soon":
        return [
          eq(schema.subscription.status, "active"),
          gte(schema.subscription.expireAt, new Date(now + offset)),
          lte(schema.subscription.expireAt, new Date(now + offset + window)),
        ];
      case "expired_recently":
        return [
          gte(schema.subscription.expireAt, new Date(now - offset - window)),
          lte(schema.subscription.expireAt, new Date(now - offset)),
        ];
      default:
        return null;
    }
  }
}

/** Тихие часы в UTC: интервал может пересекать полночь (22 → 8). */
function inQuietHours(quietHours: { from: number; to: number } | null): boolean {
  if (!quietHours) return false;
  const hour = new Date().getUTCHours();
  const { from, to } = quietHours;
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

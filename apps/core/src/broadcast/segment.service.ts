import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, isNotNull, lt, lte, sql, type SQL } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

export const SEGMENT_KINDS = ["all", "active", "inactive", "expiring", "segment"] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export interface SegmentMember {
  subscriberId: string;
  telegramId: number;
}

export interface ResolveInput {
  kind: SegmentKind;
  segmentId?: string | null;
  /** Для kind=expiring: горизонт «скоро истечёт». */
  expiringDays?: number;
  /** Маркетинговая выборка: отписавшиеся и заблокировавшие бота исключаются. */
  marketing?: boolean;
}

const DEFAULT_EXPIRING_DAYS = 3;

/**
 * Материализация сегмента в список получателей.
 * Предикат сегмента — узкий декларативный набор полей, а не произвольный SQL:
 * произвольное правило из админки — это дыра в БД.
 */
@Injectable()
export class SegmentService {
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  async resolve(input: ResolveInput): Promise<SegmentMember[]> {
    const now = new Date();
    const filters: SQL[] = [
      eq(schema.subscriber.orgId, this.cfg.defaultOrgId),
      isNotNull(schema.subscriber.telegramId),
    ];

    let marketing = input.marketing ?? true;

    if (input.kind === "segment") {
      const predicate = await this.loadSegment(input.segmentId);
      marketing = input.marketing ?? predicate.isMarketing;
      filters.push(...this.predicateFilters(predicate.predicate, now));
    } else {
      filters.push(...this.kindFilters(input, now));
    }

    if (marketing) {
      filters.push(eq(schema.subscriber.marketingOptOut, false));
      filters.push(eq(schema.subscriber.tgBlocked, false));
    }

    const rows = await this.db
      .selectDistinct({ subscriberId: schema.subscriber.id, telegramId: schema.subscriber.telegramId })
      .from(schema.subscriber)
      .leftJoin(schema.subscription, eq(schema.subscription.subscriberId, schema.subscriber.id))
      .where(and(...filters));

    return rows
      .filter((r): r is { subscriberId: string; telegramId: number } => r.telegramId !== null)
      .map((r) => ({ subscriberId: r.subscriberId, telegramId: r.telegramId }));
  }

  private kindFilters(input: ResolveInput, now: Date): SQL[] {
    switch (input.kind) {
      case "all":
        return [];
      case "active":
        return [
          eq(schema.subscription.status, "active"),
          gte(schema.subscription.expireAt, now),
        ];
      case "inactive":
        return [lt(schema.subscription.expireAt, now)];
      case "expiring": {
        const days = input.expiringDays ?? DEFAULT_EXPIRING_DAYS;
        return [
          eq(schema.subscription.status, "active"),
          gte(schema.subscription.expireAt, now),
          lte(schema.subscription.expireAt, new Date(now.getTime() + days * 86_400_000)),
        ];
      }
      default:
        throw new BadRequestException(`неизвестный сегмент ${String(input.kind)}`);
    }
  }

  private predicateFilters(predicate: Record<string, unknown>, now: Date): SQL[] {
    const filters: SQL[] = [];

    if (typeof predicate.status === "string") {
      filters.push(eq(schema.subscription.status, predicate.status));
    }
    if (typeof predicate.expiresInDays === "number") {
      filters.push(gte(schema.subscription.expireAt, now));
      filters.push(lte(schema.subscription.expireAt, new Date(now.getTime() + predicate.expiresInDays * 86_400_000)));
    }
    if (typeof predicate.expiredWithinDays === "number") {
      filters.push(lt(schema.subscription.expireAt, now));
      filters.push(gte(schema.subscription.expireAt, new Date(now.getTime() - predicate.expiredWithinDays * 86_400_000)));
    }
    if (typeof predicate.createdWithinDays === "number") {
      filters.push(gte(schema.subscriber.createdAt, new Date(now.getTime() - predicate.createdWithinDays * 86_400_000)));
    }
    if (typeof predicate.languageCode === "string") {
      filters.push(eq(schema.subscriber.languageCode, predicate.languageCode));
    }
    if (typeof predicate.campaignLinkId === "string") {
      filters.push(eq(schema.subscriber.campaignLinkId, predicate.campaignLinkId));
    }
    if (typeof predicate.hasPaid === "boolean") {
      const exists = sql`exists (select 1 from ${schema.payment} where ${schema.payment.subscriberId} = ${schema.subscriber.id} and ${schema.payment.status} = 'paid')`;
      filters.push(predicate.hasPaid ? exists : sql`not ${exists}`);
    }

    return filters;
  }

  private async loadSegment(segmentId?: string | null) {
    if (!segmentId) throw new BadRequestException("для kind=segment нужен segmentId");
    const rows = await this.db
      .select()
      .from(schema.segment)
      .where(and(eq(schema.segment.orgId, this.cfg.defaultOrgId), eq(schema.segment.id, segmentId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException(`сегмент ${segmentId} не найден`);
    return row;
  }
}

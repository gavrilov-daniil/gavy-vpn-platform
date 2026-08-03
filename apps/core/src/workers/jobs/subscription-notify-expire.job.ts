import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../../db/db.module.js";
import { loadConfig } from "../../config.js";
import { DispatchService } from "../../broadcast/dispatch.service.js";
import { dayBucket } from "../alert.service.js";
import type { JobRunner } from "../job.types.js";

const THRESHOLDS_DAYS = [3, 1] as const;
const DAY_MS = 86_400_000;
const SEND_PAUSE_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Напоминание об истечении. Окно — ровно сутки от порога: прогон раз в день даёт
 * одно попадание на подписку. Второй барьер — dedup_key в message_log с суточным bucket'ом,
 * он же гасит повторный ручной запуск.
 *
 * marketing_opt_out не учитывается осознанно: это транзакционное уведомление о доступе,
 * а не маркетинг. tg_blocked учитывается — в заблокировавшего бота слать бессмысленно.
 */
@Injectable()
export class SubscriptionNotifyExpireJob implements JobRunner {
  readonly jobName = "subscription-notify-expire" as const;
  private readonly log = new Logger(SubscriptionNotifyExpireJob.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly dispatch: DispatchService,
  ) {}

  async run() {
    const now = Date.now();
    const bucket = dayBucket();
    const counts = { targets: 0, sent: 0, duplicate: 0, failed: 0 };

    for (const days of THRESHOLDS_DAYS) {
      const from = new Date(now + days * DAY_MS);
      const to = new Date(now + (days + 1) * DAY_MS);

      const rows = await this.db
        .select({
          subscriptionId: schema.subscription.id,
          subscriberId: schema.subscriber.id,
          telegramId: schema.subscriber.telegramId,
          expireAt: schema.subscription.expireAt,
        })
        .from(schema.subscription)
        .innerJoin(schema.subscriber, eq(schema.subscription.subscriberId, schema.subscriber.id))
        .where(
          and(
            eq(schema.subscription.orgId, this.cfg.defaultOrgId),
            inArray(schema.subscription.status, ["active", "trial"]),
            isNotNull(schema.subscription.expireAt),
            gte(schema.subscription.expireAt, from),
            lt(schema.subscription.expireAt, to),
            isNotNull(schema.subscriber.telegramId),
            eq(schema.subscriber.tgBlocked, false),
          ),
        );

      counts.targets += rows.length;

      for (const row of rows) {
        if (row.telegramId === null) continue;

        const result = await this.dispatch.send({
          subscriberId: row.subscriberId,
          telegramId: row.telegramId,
          kind: "transactional",
          refId: row.subscriptionId,
          dedupKey: `expire_notice:${row.subscriptionId}:${days}:${bucket}`,
          bodyHtml: body(days, row.expireAt),
        });

        if (result.outcome === "sent") counts.sent++;
        else if (result.outcome === "duplicate") counts.duplicate++;
        else counts.failed++;

        await sleep(SEND_PAUSE_MS);
      }
    }

    this.log.log(`напоминания об истечении: ${JSON.stringify(counts)}`);
    return counts;
  }
}

function body(days: number, expireAt: Date | null): string {
  const when = days === 1 ? "завтра" : `через ${days} дня`;
  const date = expireAt ? formatDate(expireAt) : "";
  return [
    `⏳ Подписка заканчивается <b>${when}</b>${date ? ` (${date})` : ""}.`,
    "Продлите, чтобы не потерять доступ.",
  ].join("\n");
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short" }).format(date);
}

import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, lt } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { BotClient } from "../bot/bot.client.js";

/**
 * Алерты операторам с дедупом по ключу с суточным bucket'ом: sweep крутится каждые
 * 5 минут, но об одной и той же проблеме операторы должны узнать один раз за сутки.
 *
 * Барьер — таблица job_dedup, а не Redis: дедуп обязан работать и без Redis
 * (иначе в degraded-режиме алерт повторяется на каждом тике планировщика).
 * message_log для этого не годится: там subscriber_id NOT NULL, а у алерта
 * оператору подписчика нет.
 */
@Injectable()
export class AlertService {
  private readonly log = new Logger(AlertService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly bot: BotClient,
  ) {}

  async alertOnce(dedupKey: string, text: string): Promise<"sent" | "duplicate" | "failed"> {
    const key = `alert:${dedupKey}`;

    const claimed = await this.db
      .insert(schema.jobDedup)
      .values({ key, orgId: this.cfg.defaultOrgId, kind: "alert", payload: { text: text.slice(0, 500) } })
      .onConflictDoNothing()
      .returning();

    if (claimed.length === 0) return "duplicate";

    const res = await this.bot.alert(text);
    if (!res.ok) {
      // отпускаем ключ: проблема никуда не делась, на следующем тике надо попробовать снова
      await this.db.delete(schema.jobDedup).where(eq(schema.jobDedup.key, key));
      this.log.warn(`алерт ${dedupKey} не ушёл в админский бот`);
      return "failed";
    }
    return "sent";
  }

  /** Чистка старых ключей — вызывается из джобы обслуживания. */
  async sweep(olderThanDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const deleted = await this.db
      .delete(schema.jobDedup)
      .where(and(eq(schema.jobDedup.kind, "alert"), lt(schema.jobDedup.createdAt, cutoff)))
      .returning();
    return deleted.length;
  }
}

export function dayBucket(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

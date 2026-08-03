import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { BotClient } from "../bot/bot.client.js";

export interface DispatchInput {
  subscriberId: string;
  telegramId: number;
  kind: "broadcast" | "touchpoint" | "transactional";
  refId: string;
  dedupKey: string;
  bodyHtml: string;
  buttons?: Record<string, unknown>[];
  imageFileId?: string | null;
}

export type DispatchOutcome = "sent" | "duplicate" | "blocked" | "error";
export interface DispatchResult {
  outcome: DispatchOutcome;
  telegramMessageId?: number;
  error?: string;
}

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Одна отправка «в бота» с барьером идемпотентности.
 * Запись в message_log делается ДО отправки и служит claim'ом: конфликт по dedup_key
 * означает, что этот адресат уже взят (другим воркером или прошлым запуском) — выходим.
 * Claim снимается, если отправка не состоялась не по вине адресата, — строка живёт
 * только как факт доставки (или как след блокировки бота).
 */
@Injectable()
export class DispatchService {
  private readonly log = new Logger(DispatchService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly bot: BotClient,
  ) {}

  async send(input: DispatchInput): Promise<DispatchResult> {
    const claim = await this.db
      .insert(schema.messageLog)
      .values({
        orgId: this.cfg.defaultOrgId,
        subscriberId: input.subscriberId,
        kind: input.kind,
        refId: input.refId,
        dedupKey: input.dedupKey,
        status: "sent",
      })
      .onConflictDoNothing()
      .returning();

    if (claim.length === 0) return { outcome: "duplicate" };
    const logId = claim[0].id;

    let rateLimitRetries = 0;
    for (;;) {
      const res = await this.bot.send({
        telegramId: input.telegramId,
        text: input.bodyHtml,
        buttons: input.buttons,
        imageFileId: input.imageFileId,
      });

      if (res.ok) {
        await this.db
          .update(schema.messageLog)
          .set({ telegramMessageId: res.messageId })
          .where(eq(schema.messageLog.id, logId));
        return { outcome: "sent", telegramMessageId: res.messageId };
      }

      if (res.reason === "rate_limited" && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        rateLimitRetries++;
        await sleep(Math.min((res.retryAfter ?? 1) * 1000, MAX_RETRY_AFTER_MS));
        continue;
      }

      const error = res.detail ?? res.reason;
      if (res.reason === "blocked") {
        await this.db
          .update(schema.subscriber)
          .set({ tgBlocked: true })
          .where(
            and(eq(schema.subscriber.orgId, this.cfg.defaultOrgId), eq(schema.subscriber.id, input.subscriberId)),
          );
        this.log.warn(`subscriber ${input.subscriberId} заблокировал бота, помечен tg_blocked`);

        await this.db
          .update(schema.messageLog)
          .set({ status: "failed", error })
          .where(eq(schema.messageLog.id, logId));

        return { outcome: "blocked", error };
      }

      // Сообщение не ушло — снимаем claim, иначе dedup_key навсегда закрывает повтор
      // этому адресату (рестарт бота на минуту = сотни человек без рассылки).
      // Исчерпанный rate_limit — такая же недоставка, как сетевая ошибка; blocked остаётся
      // строкой-следом выше, повторять его бессмысленно.
      await this.db.delete(schema.messageLog).where(eq(schema.messageLog.id, logId));
      this.log.warn(`отправка ${input.dedupKey} не удалась (${error}), claim снят — повтор возможен`);

      return { outcome: "error", error };
    }
  }
}

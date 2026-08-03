import { Injectable, Logger } from "@nestjs/common";
import { HttpError, request } from "@corelink/core-kit";
import { loadConfig } from "../config.js";

export interface BotSendInput {
  telegramId: number;
  text: string;
  buttons?: Record<string, unknown>[];
  imageFileId?: string | null;
}

export type BotSendResult =
  | { ok: true; messageId?: number }
  | { ok: false; reason: "blocked" | "rate_limited" | "error"; retryAfter?: number; detail?: string };

/**
 * Единственная точка обращения core → бот (контракт apps/bot NotifyController).
 * Результат отдаётся ветками, а не исключениями: blocked/rate_limited — штатные ответы
 * Telegram, и у рассылки на них разное поведение.
 * Ретраи здесь выключены: троттлинг и повтор при rate_limited решает вызывающий.
 */
@Injectable()
export class BotClient {
  private readonly log = new Logger(BotClient.name);
  private readonly cfg = loadConfig();

  /** Рассылки и касания: бот типизует причину отказа, кампания не падает из-за одного получателя. */
  async send(input: BotSendInput): Promise<BotSendResult> {
    return this.post("/bot/broadcast-send", input);
  }

  /** Ответ оператора и транзакционные уведомления. */
  async notify(input: BotSendInput): Promise<BotSendResult> {
    return this.post("/bot/notify", input);
  }

  /**
   * Алерт операторам через второй (админский) бот: нода разъехалась, скоро продление сервера.
   * Не бросает: алерт не имеет права ронять джобу, которая его вызвала.
   */
  async alert(text: string, opts: { silent?: boolean } = {}): Promise<{ ok: boolean; messageId: number | null }> {
    try {
      const res = await request<{ ok: boolean; messageId: number | null }>(`${this.cfg.botInternalUrl}/bot/alert`, {
        method: "POST",
        json: { text, silent: opts.silent ?? false },
        headers: { "x-service-token": this.cfg.serviceToken },
        retries: 0,
        timeoutMs: 10_000,
        provider: "bot",
      });
      return { ok: Boolean(res.body?.ok), messageId: res.body?.messageId ?? null };
    } catch (err) {
      const detail = err instanceof HttpError || err instanceof Error ? err.message : String(err);
      this.log.warn(`алерт не доставлен: ${detail}`);
      return { ok: false, messageId: null };
    }
  }

  private async post(path: string, input: BotSendInput): Promise<BotSendResult> {
    try {
      const res = await request<BotSendResult>(`${this.cfg.botInternalUrl}${path}`, {
        method: "POST",
        json: {
          tgId: input.telegramId,
          text: input.text,
          buttons: input.buttons ?? [],
          imageFileId: input.imageFileId ?? undefined,
        },
        headers: { "x-service-token": this.cfg.serviceToken },
        retries: 0,
        timeoutMs: 10_000,
        provider: "bot",
      });

      const body = res.body;
      if (body?.ok) return { ok: true, messageId: body.messageId };
      const reason = body?.reason === "blocked" || body?.reason === "rate_limited" ? body.reason : "error";
      return { ok: false, reason, retryAfter: body?.retryAfter, detail: body?.detail };
    } catch (err) {
      const detail = err instanceof HttpError || err instanceof Error ? err.message : String(err);
      this.log.warn(`bot ${path} недоступен: ${detail}`);
      return { ok: false, reason: "error", detail };
    }
  }
}

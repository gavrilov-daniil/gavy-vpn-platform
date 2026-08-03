import { Injectable, Logger } from "@nestjs/common";
import { request } from "@corelink/core-kit";
import { loadConfig } from "../config.js";

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

/**
 * Второй бот — только алерты операторам (новый платёж, нода упала, провижнинг сломался,
 * скоро продление сервера). Роутинга и меню здесь нет, поэтому grammy не нужен:
 * два вызова HTTP API Telegram через общий `request` (ретраи, таймауты, аудит с маскированием).
 *
 * Ни один метод не бросает: алерт не имеет права ронять бизнес-флоу, который его вызвал.
 */
@Injectable()
export class AdminBotClient {
  private readonly log = new Logger(AdminBotClient.name);
  private readonly cfg = loadConfig();

  get enabled(): boolean {
    return Boolean(this.cfg.adminBotToken && this.cfg.adminChatId);
  }

  /** Возвращает message_id — по нему алерт можно потом отредактировать (например, «инцидент закрыт»). */
  async sendAlert(text: string, opts: { silent?: boolean } = {}): Promise<number | null> {
    if (!this.enabled) {
      this.log.debug("админский бот не настроен, алерт пропущен");
      return null;
    }

    try {
      const res = await request<TelegramResponse<{ message_id: number }>>(this.url("sendMessage"), {
        method: "POST",
        json: {
          chat_id: this.cfg.adminChatId,
          text,
          parse_mode: "HTML",
          disable_notification: opts.silent ?? false,
          link_preview_options: { is_disabled: true },
        },
        provider: "telegram-admin",
        timeoutMs: 8_000,
        retries: 2,
      });
      return res.body.ok ? (res.body.result?.message_id ?? null) : null;
    } catch (err) {
      this.log.warn(`алерт не отправлен: ${errorText(err)}`);
      return null;
    }
  }

  async editAlert(messageId: number, text: string): Promise<boolean> {
    if (!this.enabled) return false;

    try {
      const res = await request<TelegramResponse<unknown>>(this.url("editMessageText"), {
        method: "POST",
        json: {
          chat_id: this.cfg.adminChatId,
          message_id: messageId,
          text,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        },
        provider: "telegram-admin",
        timeoutMs: 8_000,
        retries: 2,
      });
      return res.body.ok;
    } catch (err) {
      this.log.warn(`алерт не отредактирован: ${errorText(err)}`);
      return false;
    }
  }

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.cfg.adminBotToken}/${method}`;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Bot, GrammyError, InlineKeyboard } from "grammy";
import type { Update } from "grammy/types";
import { loadConfig } from "../config.js";
import { CoreApiClient } from "../core-api/core-api.client.js";
import { AdminBotClient } from "../admin-bot/admin-bot.client.js";
import { eventFromUpdate } from "./bot-events.js";
import { messages } from "./messages.js";
import { registerMenuHandlers } from "./handlers/menu.handlers.js";
import { registerSalesHandlers } from "./handlers/sales.handlers.js";
import { registerSupportHandlers } from "./handlers/support.handlers.js";
import { errorText, type HandlerDeps } from "./ui.js";

const ALLOWED_UPDATES = ["message", "callback_query", "pre_checkout_query"] as const;

export interface NotifyButton {
  text: string;
  url?: string;
  callbackData?: string;
}

export type SendResult =
  | { ok: true; messageId: number }
  | { ok: false; reason: "blocked" | "rate_limited" | "error"; retryAfter?: number; detail?: string };

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(BotService.name);
  private readonly cfg = loadConfig();
  private readonly bot: Bot;

  constructor(
    private readonly core: CoreApiClient,
    private readonly admin: AdminBotClient,
  ) {
    this.bot = new Bot(this.cfg.botToken);
  }

  async onModuleInit(): Promise<void> {
    // init() подтягивает botInfo — без него handleUpdate не работает, а username нужен для реф-ссылок
    await this.bot.init();
    this.registerHandlers();

    if (this.cfg.webhookUrl) {
      if (!this.cfg.webhookSecret) {
        this.log.warn("BOT_WEBHOOK_SECRET пуст: POST /tg примет апдейт от кого угодно");
      }
      await this.bot.api.setWebhook(this.cfg.webhookUrl, {
        secret_token: this.cfg.webhookSecret || undefined,
        allowed_updates: [...ALLOWED_UPDATES],
        // false: апдейты, накопившиеся за деплой, — это оплаты и обращения, терять их нельзя
        drop_pending_updates: false,
      });
      this.log.log(`webhook: ${this.cfg.webhookUrl}`);
      return;
    }

    // Локальная разработка. Оставшийся с прода вебхук приведёт к 409 на getUpdates — снимаем.
    await this.bot.api.deleteWebhook({ drop_pending_updates: false });
    void this.bot.start({ allowed_updates: [...ALLOWED_UPDATES] });
    this.log.log("long polling (BOT_WEBHOOK_URL не задан)");
  }

  async onModuleDestroy(): Promise<void> {
    await this.bot.stop();
  }

  handleUpdate(update: Update): Promise<void> {
    return this.bot.handleUpdate(update);
  }

  async sendToUser(tgId: number, text: string, buttons?: NotifyButton[]): Promise<SendResult> {
    try {
      const message = await this.bot.api.sendMessage(tgId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: buildKeyboard(buttons),
      });
      return { ok: true, messageId: message.message_id };
    } catch (err) {
      return classifySendError(err);
    }
  }

  private registerHandlers(): void {
    // Аналитика — первым middleware, чтобы видеть и те апдейты, которые дальше никто не разберёт.
    this.bot.use(async (ctx, next) => {
      const event = eventFromUpdate(ctx.update);
      if (event) void this.core.trackEvent(event);
      await next();
    });

    this.bot.use(async (ctx, next) => {
      try {
        await next();
      } catch (err) {
        // Экран не отрисовался: гасим «часики», иначе кнопка молча висит нажатой.
        // Сообщение в чат не шлём — обработчик мог уже ответить сам (например, об оплате).
        if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({ text: messages.failure, show_alert: true }).catch(() => undefined);
        }
        throw err;
      }
    });

    const deps: HandlerDeps = {
      core: this.core,
      admin: this.admin,
      cfg: this.cfg,
      botUsername: () => this.bot.botInfo.username,
    };

    registerMenuHandlers(this.bot, deps);
    registerSalesHandlers(this.bot, deps);
    registerSupportHandlers(this.bot, deps); // всегда последним: ловит всё неразобранное

    this.bot.catch((err) => {
      this.log.error(`update ${err.ctx.update.update_id} упал: ${errorText(err.error)}`);
    });
  }
}

function buildKeyboard(buttons?: NotifyButton[]): InlineKeyboard | undefined {
  if (!buttons || buttons.length === 0) return undefined;

  const kb = new InlineKeyboard();
  for (const button of buttons) {
    if (button.url) kb.url(button.text, button.url).row();
    else if (button.callbackData) kb.text(button.text, button.callbackData).row();
  }
  return kb;
}

/**
 * Рассыльщику нужен разбор по причинам, а не «упало»: заблокировавший бота получатель
 * должен помечаться failed персонально, а 429 — это пауза для всей кампании.
 */
function classifySendError(err: unknown): SendResult {
  if (err instanceof GrammyError) {
    if (err.error_code === 403) return { ok: false, reason: "blocked", detail: err.description };
    if (err.error_code === 429) {
      return { ok: false, reason: "rate_limited", retryAfter: err.parameters.retry_after, detail: err.description };
    }
    return { ok: false, reason: "error", detail: err.description };
  }
  return { ok: false, reason: "error", detail: errorText(err) };
}

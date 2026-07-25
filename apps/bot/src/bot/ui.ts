import { GrammyError, InlineKeyboard, type Context } from "grammy";
import type { BotConfig } from "../config.js";
import type { CoreApiClient } from "../core-api/core-api.client.js";
import type { AdminBotClient } from "../admin-bot/admin-bot.client.js";

export interface HandlerDeps {
  core: CoreApiClient;
  admin: AdminBotClient;
  cfg: BotConfig;
  /** username бота — нужен для реф-ссылок; заполняется после bot.init(). */
  botUsername: () => string;
}

/**
 * Telegram режет callback_data на 64 байтах, а `pay:<uuid>:<uuid>` — это 77.
 * Поэтому в кнопку кладём префикс id, а полный id восстанавливаем по списку из core.
 */
export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

/** Неоднозначный префикс трактуем как промах: лучше попросить открыть экран заново, чем взять не тот объект. */
export function pickByShort<T>(items: T[], getId: (item: T) => string, short: string): T | null {
  const matches = items.filter((item) => shortId(getId(item)) === short);
  return matches.length === 1 ? matches[0] : null;
}

export function mainMenuKeyboard(opts: { trialAvailable: boolean; hasSubscription: boolean }): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(opts.hasSubscription ? "🚀 Продлить доступ" : "🚀 Выбрать тариф", "menu:plans").row();
  if (opts.trialAvailable) kb.text("⚡️ Попробовать бесплатно", "menu:trial").row();
  kb.text("👤 Моя подписка", "menu:status").text("💳 Баланс", "menu:balance").row();
  kb.text("📱 Устройства", "menu:devices").text("📖 Инструкция", "menu:instructions").row();
  kb.text("🎁 Пригласить друга", "menu:refer").row();
  kb.text("💬 Поддержка", "menu:support");
  return kb;
}

export function backKeyboard(target = "menu:home"): InlineKeyboard {
  return new InlineKeyboard().text("← Назад", target);
}

/**
 * Единая отрисовка экрана: гасим «часики» на кнопке и правим текущее сообщение,
 * чтобы не засорять чат. Повторный тап по той же кнопке Telegram считает ошибкой — гасим её.
 */
export async function showScreen(ctx: Context, text: string, keyboard?: InlineKeyboard): Promise<void> {
  if (ctx.callbackQuery) {
    // протухший (>15 мин) callback отвечать нельзя — не роняем из-за этого экран
    await ctx.answerCallbackQuery().catch(() => undefined);
  }

  const options = {
    parse_mode: "HTML" as const,
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard,
  };

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (err) {
      if (err instanceof GrammyError && err.description.includes("message is not modified")) return;
      // сообщение могло стать нередактируемым (старое/удалённое) — шлём новым
    }
  }

  await ctx.reply(text, options);
}

/** Бот не хранит состояние: подписчик определяется по telegram id на каждом экране. */
export async function resolveSubscriberId(ctx: Context, deps: HandlerDeps): Promise<string | null> {
  const from = ctx.from;
  if (!from) return null;

  const subscriber = await deps.core.resolveSubscriber({
    telegramId: from.id,
    username: from.username,
    languageCode: from.language_code,
  });
  return subscriber.subscriberId;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { InlineKeyboard, type Bot } from "grammy";
import { messages } from "../messages.js";
import type { HandlerDeps } from "../ui.js";

/**
 * Регистрируется ПОСЛЕДНИМ: всё, что не разобрали команды и callback'и, —
 * это обращение в поддержку. Сцен и FSM нет, поэтому «режима поддержки» тоже нет:
 * любое свободное сообщение уходит оператору.
 */
export function registerSupportHandlers(bot: Bot, deps: HandlerDeps): void {
  bot.on("message", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const text = ctx.message.text ?? ctx.message.caption ?? "";
    if (!text.trim()) {
      await ctx.reply(messages.supportOnlyText);
      return;
    }

    await deps.core.supportInbound({
      telegramUserId: from.id,
      username: from.username,
      languageCode: from.language_code,
      text,
      // update_id и message_id — ключи дедупа повторной доставки вебхука на стороне core
      updateId: ctx.update.update_id,
      telegramMessageId: ctx.message.message_id,
    });

    await ctx.reply(messages.supportReceived, {
      reply_markup: new InlineKeyboard().text("← В меню", "menu:home"),
    });
  });
}

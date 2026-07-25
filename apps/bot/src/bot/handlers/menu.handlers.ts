import { InlineKeyboard, type Bot, type Context } from "grammy";
import { messages } from "../messages.js";
import { backKeyboard, mainMenuKeyboard, resolveSubscriberId, showScreen, type HandlerDeps } from "../ui.js";

export function registerMenuHandlers(bot: Bot, deps: HandlerDeps): void {
  bot.command("start", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    // startPayload — атрибуция (c_<код> кампании / ref_<код> реферала). Пишется в core только при создании.
    const startPayload = typeof ctx.match === "string" ? ctx.match.trim() : "";
    const subscriber = await deps.core.resolveSubscriber({
      telegramId: from.id,
      username: from.username,
      languageCode: from.language_code,
      startPayload: startPayload || undefined,
    });

    const overview = await deps.core.getOverview(subscriber.subscriberId);
    await showScreen(
      ctx,
      messages.home(from.first_name),
      mainMenuKeyboard({ trialAvailable: overview.trialAvailable, hasSubscription: Boolean(overview.subscription) }),
    );
  });

  bot.callbackQuery("menu:home", async (ctx) => {
    const overview = await loadOverview(ctx, deps);
    if (!overview) return;
    await showScreen(
      ctx,
      messages.home(ctx.from?.first_name ?? ""),
      mainMenuKeyboard({ trialAvailable: overview.trialAvailable, hasSubscription: Boolean(overview.subscription) }),
    );
  });

  bot.callbackQuery("menu:status", async (ctx) => {
    const overview = await loadOverview(ctx, deps);
    if (!overview) return;

    const kb = new InlineKeyboard();
    if (overview.subscription) {
      kb.url("🔗 Подключиться", overview.subscription.subscriptionUrl).row();
      kb.text("🚀 Продлить", "menu:plans").row();
    } else {
      kb.text("🚀 Выбрать тариф", "menu:plans").row();
      if (overview.trialAvailable) kb.text("⚡️ Попробовать бесплатно", "menu:trial").row();
    }
    kb.text("← Назад", "menu:home");

    await showScreen(ctx, messages.status(overview), kb);
  });

  bot.callbackQuery("menu:devices", async (ctx) => {
    const overview = await loadOverview(ctx, deps);
    if (!overview) return;
    await showScreen(ctx, messages.devices(overview), backKeyboard());
  });

  bot.callbackQuery("menu:instructions", async (ctx) => {
    const overview = await loadOverview(ctx, deps);
    if (!overview) return;

    const kb = new InlineKeyboard().url("📥 Установить Happ", deps.cfg.happInstallUrl).row();
    if (overview.subscription) kb.url("🔗 Открыть подписку", overview.subscription.subscriptionUrl).row();
    kb.text("← Назад", "menu:home");

    await showScreen(
      ctx,
      messages.instructions(overview.subscription?.subscriptionUrl ?? null, deps.cfg.happInstallUrl),
      kb,
    );
  });

  bot.callbackQuery("menu:refer", async (ctx) => {
    const overview = await loadOverview(ctx, deps);
    if (!overview) return;

    const link = `https://t.me/${deps.botUsername()}?start=ref_${overview.referral.code}`;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(
      "Пользуюсь этим VPN — быстрый и без рекламы. Держи ссылку:",
    )}`;

    const kb = new InlineKeyboard().url("📤 Поделиться", shareUrl).row().text("← Назад", "menu:home");
    await showScreen(ctx, messages.referral(overview, link), kb);
  });

  bot.callbackQuery("menu:support", async (ctx) => {
    await showScreen(ctx, messages.supportPrompt, backKeyboard());
  });
}

/** Все экраны меню начинаются одинаково: кто это → его состояние. */
async function loadOverview(ctx: Context, deps: HandlerDeps) {
  const subscriberId = await resolveSubscriberId(ctx, deps);
  if (!subscriberId) return null;
  return deps.core.getOverview(subscriberId);
}

import { InlineKeyboard, type Bot, type Context } from "grammy";
import { buildIdempotencyKey } from "@corelink/core-kit";
import type { CreatedPaymentDto, PlanDto } from "../../core-api/core-api.client.js";
import { formatMoney, messages } from "../messages.js";
import { backKeyboard, pickByShort, resolveSubscriberId, shortId, showScreen, type HandlerDeps } from "../ui.js";

// Telegram обрежет более длинные значения молча — режем сами, чтобы счёт не выглядел битым.
const INVOICE_TITLE_LIMIT = 32;
const INVOICE_DESCRIPTION_LIMIT = 255;

const IN_FLIGHT_TTL_MS = 5 * 60_000;
const inFlight = new Map<string, number>();

/**
 * Дабл-тап по кнопке оплаты не должен создавать второй счёт.
 * Это барьер в памяти процесса (окно совпадает с окном ключа идемпотентности);
 * настоящий — дедуп в core по заголовку x-client-request-id, он переживает рестарт и второй инстанс.
 */
function claim(key: string): boolean {
  const now = Date.now();
  for (const [k, at] of inFlight) {
    if (now - at > IN_FLIGHT_TTL_MS) inFlight.delete(k);
  }
  if (inFlight.has(key)) return false;
  inFlight.set(key, now);
  return true;
}

export function registerSalesHandlers(bot: Bot, deps: HandlerDeps): void {
  bot.callbackQuery("menu:plans", async (ctx) => {
    const plans = await loadSellablePlans(deps);
    if (plans.length === 0) {
      await showScreen(ctx, messages.plansEmpty, backKeyboard());
      return;
    }

    const kb = new InlineKeyboard();
    for (const plan of plans) {
      kb.text(`${plan.title} — ${formatMoney(plan.priceKopeks)}`, `plan:${shortId(plan.id)}`).row();
    }
    kb.text("← Назад", "menu:home");

    await showScreen(ctx, messages.plansHeader, kb);
  });

  bot.callbackQuery(/^plan:([0-9a-f]{1,8})$/, async (ctx) => {
    const plan = pickByShort(await deps.core.listPlans(), (p) => p.id, ctx.match[1]);
    if (!plan) {
      await showScreen(ctx, messages.staleButton, backKeyboard("menu:plans"));
      return;
    }

    const methods = await deps.core.listPaymentMethods("plan");
    if (methods.length === 0) {
      await showScreen(ctx, messages.methodsEmpty, backKeyboard("menu:plans"));
      return;
    }

    const kb = new InlineKeyboard();
    for (const method of methods) {
      kb.text(method.title, `pay:${shortId(method.merchantId)}:${shortId(plan.id)}`).row();
    }
    kb.text("← Назад", "menu:plans");

    await showScreen(ctx, messages.planCard(plan), kb);
  });

  bot.callbackQuery(/^pay:([0-9a-f]{1,8}):([0-9a-f]{1,8})$/, async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const [, merchantShort, planShort] = ctx.match;
    const [plans, methods] = await Promise.all([deps.core.listPlans(), deps.core.listPaymentMethods("plan")]);
    const plan = pickByShort(plans, (p) => p.id, planShort);
    const method = pickByShort(methods, (m) => m.merchantId, merchantShort);
    if (!plan || !method) {
      await showScreen(ctx, messages.staleButton, backKeyboard("menu:plans"));
      return;
    }

    const key = buildIdempotencyKey({
      subjectId: String(from.id),
      action: "pay_plan",
      params: { merchantId: method.merchantId, planId: plan.id },
    });
    if (!claim(key)) {
      await ctx.answerCallbackQuery({ text: messages.payInProgress });
      return;
    }

    try {
      const subscriberId = await resolveSubscriberId(ctx, deps);
      if (!subscriberId) return;

      const payment = await deps.core.createPayment(
        {
          subscriberId,
          merchantId: method.merchantId,
          purpose: "plan",
          planId: plan.id,
          telegramUserId: from.id,
        },
        key,
      );

      await deliverInvoice(ctx, {
        payment,
        title: plan.title,
        description: messages.starsInvoiceDescription(plan),
        screenText: messages.payLink(plan),
        backTarget: `plan:${planShort}`,
      });
    } catch (err) {
      inFlight.delete(key); // счёт не создан — не блокируем повторную попытку на 5 минут
      throw err;
    }
  });

  bot.callbackQuery("menu:balance", async (ctx) => {
    const subscriberId = await resolveSubscriberId(ctx, deps);
    if (!subscriberId) return;

    const [overview, methods] = await Promise.all([
      deps.core.getOverview(subscriberId),
      deps.core.listPaymentMethods("topup"),
    ]);

    if (methods.length === 0) {
      await showScreen(ctx, `${messages.balance(overview)}\n\n${messages.methodsEmpty}`, backKeyboard());
      return;
    }

    const kb = new InlineKeyboard();
    for (const amount of deps.cfg.topupAmountsKopeks) {
      for (const method of methods) {
        kb.text(`${formatMoney(amount)} · ${method.title}`, `topup:${shortId(method.merchantId)}:${amount}`);
      }
      kb.row();
    }
    kb.text("← Назад", "menu:home");

    await showScreen(ctx, messages.topupHeader(overview.balanceKopeks), kb);
  });

  bot.callbackQuery(/^topup:([0-9a-f]{1,8}):(\d+)$/, async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const [, merchantShort, amountRaw] = ctx.match;
    const amountKopeks = Number(amountRaw);
    const method = pickByShort(await deps.core.listPaymentMethods("topup"), (m) => m.merchantId, merchantShort);
    // сумму берём только из своего списка — произвольные значения из callback_data не принимаем
    if (!method || !deps.cfg.topupAmountsKopeks.includes(amountKopeks)) {
      await showScreen(ctx, messages.staleButton, backKeyboard("menu:balance"));
      return;
    }

    const key = buildIdempotencyKey({
      subjectId: String(from.id),
      action: "topup",
      params: { merchantId: method.merchantId, amountKopeks },
    });
    if (!claim(key)) {
      await ctx.answerCallbackQuery({ text: messages.payInProgress });
      return;
    }

    try {
      const subscriberId = await resolveSubscriberId(ctx, deps);
      if (!subscriberId) return;

      const payment = await deps.core.createPayment(
        {
          subscriberId,
          merchantId: method.merchantId,
          purpose: "topup",
          amountKopeks,
          telegramUserId: from.id,
        },
        key,
      );

      await deliverInvoice(ctx, {
        payment,
        title: "Пополнение баланса",
        description: `Пополнение баланса на ${formatMoney(amountKopeks)}`,
        screenText: messages.topupLink(amountKopeks),
        backTarget: "menu:balance",
      });
    } catch (err) {
      inFlight.delete(key);
      throw err;
    }
  });

  bot.callbackQuery("menu:trial", async (ctx) => {
    const subscriberId = await resolveSubscriberId(ctx, deps);
    if (!subscriberId) return;

    const overview = await deps.core.getOverview(subscriberId);
    if (!overview.trialAvailable) {
      await showScreen(ctx, messages.trialUsed, new InlineKeyboard().text("🚀 Выбрать тариф", "menu:plans").row().text("← Назад", "menu:home"));
      return;
    }

    const kb = new InlineKeyboard().text("⚡️ Активировать", "trial:activate").row().text("← Назад", "menu:home");
    await showScreen(ctx, messages.trialOffer, kb);
  });

  bot.callbackQuery("trial:activate", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const subscriberId = await resolveSubscriberId(ctx, deps);
    if (!subscriberId) return;

    const key = buildIdempotencyKey({ subjectId: String(from.id), action: "trial_activate" });
    if (!claim(key)) {
      await ctx.answerCallbackQuery({ text: messages.payInProgress });
      return;
    }

    let result;
    try {
      result = await deps.core.activateTrial(subscriberId, key);
    } catch (err) {
      inFlight.delete(key);
      throw err;
    }

    if (!result.ok) {
      await showScreen(ctx, messages.trialUsed, new InlineKeyboard().text("🚀 Выбрать тариф", "menu:plans").row().text("← Назад", "menu:home"));
      return;
    }

    const kb = new InlineKeyboard();
    if (result.subscriptionUrl) kb.url("🔗 Подключиться", result.subscriptionUrl).row();
    kb.text("📖 Инструкция", "menu:instructions").row().text("← В меню", "menu:home");

    await showScreen(ctx, messages.trialActivated(result.expireAt), kb);
  });

  // Ответить надо за 10 секунд, иначе Telegram отменит платёж сам.
  bot.on("pre_checkout_query", async (ctx) => {
    const query = ctx.preCheckoutQuery;
    try {
      const verdict = await deps.core.starsPreCheckout({
        invoicePayload: query.invoice_payload,
        totalAmount: query.total_amount,
        telegramUserId: query.from.id,
      });
      await ctx.answerPreCheckoutQuery(verdict.ok, verdict.ok ? undefined : messages.preCheckoutRejected);
    } catch (err) {
      // core недоступен: отказываем. Принять деньги, которые не сможем привязать к счёту, хуже.
      await ctx.answerPreCheckoutQuery(false, messages.preCheckoutRejected);
      throw err;
    }
  });

  bot.on("message:successful_payment", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const payment = ctx.message.successful_payment;

    const key = buildIdempotencyKey({
      subjectId: String(from.id),
      action: "stars_confirm",
      params: { chargeId: payment.telegram_payment_charge_id },
    });

    try {
      const confirm = await deps.core.starsConfirm(
        {
          invoicePayload: payment.invoice_payload,
          totalAmount: payment.total_amount,
          telegramPaymentChargeId: payment.telegram_payment_charge_id,
          telegramUserId: from.id,
        },
        key,
      );

      if (!confirm.ok) {
        await ctx.reply(messages.paymentPending, { parse_mode: "HTML" });
        return;
      }

      await ctx.reply(messages.paymentSuccess(confirm), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("👤 Моя подписка", "menu:status"),
      });

      if (!confirm.alreadyProcessed) {
        void deps.admin.sendAlert(
          messages.adminNewPayment({
            telegramUserId: from.id,
            username: from.username,
            amountStars: payment.total_amount,
            planTitle: confirm.planTitle,
          }),
        );
      }
    } catch (err) {
      // Деньги Telegram уже списал — это инцидент, а не обычная ошибка запроса.
      await ctx.reply(messages.paymentPending, { parse_mode: "HTML" });
      void deps.admin.sendAlert(
        messages.adminConfirmFailed({
          telegramUserId: from.id,
          chargeId: payment.telegram_payment_charge_id,
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
      throw err;
    }
  });
}

async function loadSellablePlans(deps: HandlerDeps): Promise<PlanDto[]> {
  const plans = await deps.core.listPlans();
  return plans.filter((plan) => !plan.isTrial).sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Два исхода создания счёта: обычный провайдер вернул payUrl, либо Stars —
 * тогда внешнего API нет и счёт выставляет сам бот (currency XTR, пустой provider_token).
 */
async function deliverInvoice(
  ctx: Context,
  args: { payment: CreatedPaymentDto; title: string; description: string; screenText: string; backTarget: string },
): Promise<void> {
  const stars = args.payment.deferredToBot;
  if (stars) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    await ctx.replyWithInvoice(
      args.title.slice(0, INVOICE_TITLE_LIMIT),
      args.description.slice(0, INVOICE_DESCRIPTION_LIMIT),
      stars.payload,
      "XTR",
      [{ label: args.title.slice(0, INVOICE_TITLE_LIMIT), amount: stars.amountStars }],
      { provider_token: "" },
    );
    return;
  }

  if (args.payment.payUrl) {
    const kb = new InlineKeyboard().url("💳 Оплатить", args.payment.payUrl).row().text("← Назад", args.backTarget);
    await showScreen(ctx, args.screenText, kb);
    return;
  }

  await showScreen(ctx, messages.failure, backKeyboard(args.backTarget));
}

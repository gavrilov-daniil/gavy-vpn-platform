import type { Update } from "grammy/types";

export interface BotEvent {
  event: string;
  telegramUserId?: number;
  /** update_id — ключ дедупа повторной доставки вебхука на стороне core. */
  updateId?: number;
  payload: Record<string, unknown>;
}

const STATIC_CALLBACKS: Record<string, string> = {
  "menu:home": "menu_home",
  "menu:plans": "menu_plans",
  "menu:status": "menu_status",
  "menu:trial": "menu_trial",
  "menu:balance": "menu_balance",
  "menu:refer": "menu_refer",
  "menu:support": "menu_support",
  "menu:devices": "menu_devices",
  "menu:instructions": "menu_instructions",
  "trial:activate": "trial_activate",
};

// Порядок важен: первое совпадение выигрывает.
const CALLBACK_RULES: [RegExp, string][] = [
  [/^plan:/, "plan_open"],
  [/^pay:/, "pay_click"],
  [/^topup:/, "topup_click"],
];

/**
 * Чистая функция: апдейт → продуктовое событие. Текст сообщений в аналитику не уходит,
 * только длина — переписка юзера не должна размазываться по аналитическим таблицам.
 */
export function eventFromUpdate(update: Update): BotEvent | null {
  const updateId = update.update_id;

  if (update.callback_query) {
    const data = update.callback_query.data ?? "";
    return {
      event: STATIC_CALLBACKS[data] ?? matchRule(data) ?? "callback_other",
      telegramUserId: update.callback_query.from.id,
      updateId,
      payload: { data },
    };
  }

  if (update.pre_checkout_query) {
    return {
      event: "payment_pre_checkout",
      telegramUserId: update.pre_checkout_query.from.id,
      updateId,
      payload: {
        invoicePayload: update.pre_checkout_query.invoice_payload,
        totalAmount: update.pre_checkout_query.total_amount,
        currency: update.pre_checkout_query.currency,
      },
    };
  }

  if (update.message) {
    const message = update.message;
    const telegramUserId = message.from?.id;

    if (message.successful_payment) {
      return {
        event: "payment_success",
        telegramUserId,
        updateId,
        payload: {
          invoicePayload: message.successful_payment.invoice_payload,
          totalAmount: message.successful_payment.total_amount,
          currency: message.successful_payment.currency,
        },
      };
    }

    const text = message.text ?? "";
    if (text.startsWith("/start")) {
      const startPayload = text.slice("/start".length).trim();
      return {
        event: "start",
        telegramUserId,
        updateId,
        payload: startPayload ? { startPayload } : {},
      };
    }
    if (text.startsWith("/")) {
      return {
        event: "command",
        telegramUserId,
        updateId,
        payload: { command: text.split(/\s+/)[0] },
      };
    }

    return { event: "message_in", telegramUserId, updateId, payload: { length: text.length } };
  }

  return null;
}

function matchRule(data: string): string | null {
  for (const [pattern, event] of CALLBACK_RULES) {
    if (pattern.test(data)) return event;
  }
  return null;
}

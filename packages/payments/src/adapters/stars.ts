import {
  settingNumber,
  PaymentAdapterError,
  type CreateInvoiceInput,
  type CreatedInvoice,
  type MerchantConfig,
  type ParsedWebhook,
  type PaymentAdapter,
  type WebhookRequest,
} from "../types.js";

export const STARS_INVOICE_PREFIX = "gavy-stars:";

export function buildStarsPayload(orderId: string): string {
  return `${STARS_INVOICE_PREFIX}${orderId}`;
}

export function extractOrderIdFromStarsPayload(payload: string): string | null {
  if (!payload.startsWith(STARS_INVOICE_PREFIX)) return null;
  const orderId = payload.slice(STARS_INVOICE_PREFIX.length);
  return orderId.length > 0 ? orderId : null;
}

/**
 * Telegram Stars. Внешнего API нет: счёт выставляет БОТ через replyWithInvoice
 * (providerToken пустой, currency XTR), а «вебхук» — это апдейты
 * pre_checkout_query / successful_payment, приходящие в бота.
 *
 * Поэтому createInvoice не делает HTTP-вызов, а возвращает deferredToBot —
 * дальше бот выставляет счёт сам. Подписи нет: подлинность даёт сам Telegram,
 * а бизнес-проверка — совпадение payload и суммы.
 */
export const starsAdapter: PaymentAdapter = {
  provider: "stars",
  supportedPurposes: ["topup", "plan", "gift"],

  isConfigured(merchant) {
    // токен бота живёт в конфиге бота; мерчанту нужен лишь курс
    return settingNumber(merchant, "stars_to_kopeks_rate", 100) > 0;
  },

  async createInvoice(merchant: MerchantConfig, input: CreateInvoiceInput): Promise<CreatedInvoice> {
    if (!input.telegramUserId) {
      throw new PaymentAdapterError("stars: нужен telegramUserId", "STARS_NO_TG_USER");
    }
    const rate = settingNumber(merchant, "stars_to_kopeks_rate", 100);
    const amountStars = Math.max(1, Math.ceil(input.amountKopeks / rate));
    return {
      providerPaymentId: input.orderId, // до оплаты; после — telegram_payment_charge_id
      deferredToBot: { payload: buildStarsPayload(input.orderId), amountStars },
    };
  },

  verifyWebhook(): boolean {
    // апдейты приходят от Telegram в бота, там же проверяется secret_token вебхука
    return true;
  },

  parseWebhook(_merchant, req: WebhookRequest): ParsedWebhook {
    const body = JSON.parse(req.rawBody) as Record<string, unknown>;
    const payload = String(body.invoice_payload ?? "");
    const orderId = extractOrderIdFromStarsPayload(payload);
    if (!orderId) {
      throw new PaymentAdapterError("stars: неизвестный формат payload", "STARS_UNKNOWN_PAYLOAD");
    }
    return {
      providerPaymentId: orderId,
      providerRef: body.telegram_payment_charge_id ? String(body.telegram_payment_charge_id) : undefined,
      status: "paid",
      raw: body,
    };
  },
};

/**
 * Бизнес-проверка перед подтверждением оплаты звёздами.
 * Подписи нет, поэтому сверяем сумму: иначе клиент мог бы оплатить счёт
 * на 1 звезду и получить план за 500.
 */
export function verifyStarsCharge(input: {
  invoicePayload: string;
  totalAmount: number;
  expectedAmountStars: number;
}): { ok: true; orderId: string } | { ok: false; reason: "unknown_payload_format" | "amount_mismatch" } {
  const orderId = extractOrderIdFromStarsPayload(input.invoicePayload);
  if (!orderId) return { ok: false, reason: "unknown_payload_format" };
  if (input.totalAmount !== input.expectedAmountStars) return { ok: false, reason: "amount_mismatch" };
  return { ok: true, orderId };
}

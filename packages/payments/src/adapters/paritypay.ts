import { createHmac } from "node:crypto";
import { request } from "@vpn/core-kit";
import { safeCompare } from "@vpn/core-kit";
import { resolveProviderBaseUrl } from "../provider-urls.js";
import {
  kopeksToRubles,
  requireCredential,
  settingNumber,
  type CreateInvoiceInput,
  type CreatedInvoice,
  type MerchantConfig,
  type ParsedWebhook,
  type PaymentAdapter,
  type PaymentStatus,
  type WebhookRequest,
} from "../types.js";

/**
 * Подпись ParityPay: ключи параметров сортируются алфавитно, значения
 * конкатенируются БЕЗ разделителя, затем HMAC-SHA256 → hex.
 * Поля null/undefined в подпись не включаются (совпадает с поведением их PHP-стороны).
 * Перенесено буквально из прода — расхождение здесь = отвергнутые платежи.
 */
export function signParityPayParams(params: Record<string, unknown>, secret: string): string {
  const concat = Object.keys(params)
    .filter((k) => params[k] !== null && params[k] !== undefined)
    .sort()
    .map((k) => String(params[k]))
    .join("");
  return createHmac("sha256", secret).update(concat).digest("hex");
}

function mapStatus(raw: string): PaymentStatus {
  switch (raw.toUpperCase()) {
    case "PAID":
      return "paid";
    case "EXPIRED":
      return "expired";
    case "REFUNDED":
      return "refunded";
    case "NEW":
      return "pending";
    default:
      return "pending";
  }
}

export const paritypayAdapter: PaymentAdapter = {
  provider: "paritypay",
  supportedPurposes: ["topup", "plan", "gift"],

  isConfigured(merchant) {
    return Boolean(
      merchant.credentials.shop_id && merchant.credentials.api_key && merchant.credentials.webhook_secret,
    );
  },

  async createInvoice(merchant: MerchantConfig, input: CreateInvoiceInput): Promise<CreatedInvoice> {
    const apiUrl = resolveProviderBaseUrl(merchant);
    const shopId = requireCredential(merchant, "shop_id");
    const apiKey = requireCredential(merchant, "api_key");
    const expireMin = settingNumber(merchant, "invoice_ttl_min", 30);

    const body: Record<string, unknown> = {
      shop_id: shopId,
      amount: kopeksToRubles(input.amountKopeks),
      order_id: input.orderId,
      service: input.method === "card" ? "card" : "sbp",
      expire: expireMin,
    };
    if (input.callbackUrl) body.callback_url = input.callbackUrl;
    if (input.successUrl) body.success_url = input.successUrl;
    if (input.failUrl) body.fail_url = input.failUrl;
    if (input.description) body.comment = input.description;

    const res = await request<{ success?: boolean; data?: Record<string, unknown>; error?: string }>(
      `${apiUrl}/invoice/create`,
      {
        method: "POST",
        provider: "paritypay",
        json: body,
        headers: { "x-signature": signParityPayParams(body, apiKey) },
      },
    );

    const data = res.body?.data as Record<string, unknown> | undefined;
    if (!data?.id) throw new Error(`paritypay: пустой ответ (${res.body?.error ?? "no data"})`);

    return {
      // до оплаты ищем по order_id, после — перезапишем на invoice id
      providerPaymentId: input.orderId,
      providerRef: String(data.id),
      payUrl: typeof data.link === "string" ? data.link : undefined,
      expiresAt: data.expires ? new Date(String(data.expires)) : undefined,
      raw: res.body,
    };
  },

  verifyWebhook(merchant, req: WebhookRequest): boolean {
    const secret = merchant.credentials.webhook_secret;
    if (!secret) return false;
    const provided = req.headers["x-signature"] ?? req.headers["X-Signature"];
    if (!provided) return false;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody) as Record<string, unknown>;
    } catch {
      return false;
    }
    // подпись считается по полям тела, само поле подписи в неё не входит
    const { signature: _sig, ...rest } = payload;
    return safeCompare(signParityPayParams(rest, secret), String(provided));
  },

  parseWebhook(_merchant, req: WebhookRequest): ParsedWebhook {
    const payload = JSON.parse(req.rawBody) as Record<string, unknown>;
    const orderId = payload.order_id ? String(payload.order_id) : undefined;
    const invoiceId = payload.id ? String(payload.id) : undefined;
    return {
      // ищем по order_id: providerPaymentId при создании = наш orderId
      providerPaymentId: orderId ?? invoiceId ?? "",
      providerRef: invoiceId,
      status: mapStatus(String(payload.status ?? "")),
      amountKopeks: payload.amount !== undefined ? Math.round(Number(payload.amount) * 100) : undefined,
      raw: payload,
    };
  },

  async healthCheck(merchant) {
    const apiUrl = resolveProviderBaseUrl(merchant);
    const shopId = requireCredential(merchant, "shop_id");
    const apiKey = requireCredential(merchant, "api_key");
    const body = { shop_id: shopId };
    try {
      const res = await request<{ success?: boolean; data?: unknown }>(`${apiUrl}/shop/balance`, {
        method: "POST",
        provider: "paritypay",
        json: body,
        headers: { "x-signature": signParityPayParams(body, apiKey) },
        retries: 0,
      });
      return { ok: res.status === 200, detail: JSON.stringify(res.body?.data ?? {}).slice(0, 200) };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
};

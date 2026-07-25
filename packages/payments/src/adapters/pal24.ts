import { createHash } from "node:crypto";
import { request, safeCompare } from "@vpn/core-kit";
import {
  kopeksToRubles,
  requireCredential,
  settingNumber,
  settingString,
  type CreateInvoiceInput,
  type CreatedInvoice,
  type MerchantConfig,
  type ParsedWebhook,
  type PaymentAdapter,
  type PaymentStatus,
  type WebhookRequest,
} from "../types.js";

/**
 * Подпись postback'а Pal24/Pally: strtoupper(md5("OutSum:InvId:token")).
 * token — тот же Bearer, что и для API. OutSum берётся как СТРОКА из тела,
 * без переформатирования числа (иначе "100.00" != "100" и подпись не сойдётся).
 */
export function signPal24Postback(outSum: string, invId: string, token: string): string {
  return createHash("md5").update(`${outSum}:${invId}:${token}`).digest("hex").toUpperCase();
}

function mapStatus(raw: string): PaymentStatus {
  switch (raw.toUpperCase()) {
    case "SUCCESS":
    case "OVERPAID":
      return "paid";
    case "UNDERPAID":
      return "processing"; // недоплата — НЕ фулфилим, требует ручного разбора
    case "FAIL":
      return "failed";
    default:
      return "pending";
  }
}

export const pal24Adapter: PaymentAdapter = {
  provider: "pal24",
  supportedPurposes: ["topup", "plan", "gift"],

  isConfigured(merchant) {
    return Boolean(merchant.credentials.shop_id && merchant.credentials.token);
  },

  async createInvoice(merchant: MerchantConfig, input: CreateInvoiceInput): Promise<CreatedInvoice> {
    const apiUrl = settingString(merchant, "api_url", "https://pal24.pro/api/v1").replace(/\/+$/, "");
    const shopId = requireCredential(merchant, "shop_id");
    const token = requireCredential(merchant, "token");
    const ttlMin = settingNumber(merchant, "invoice_ttl_min", 30);

    const form: Record<string, string | number> = {
      shop_id: shopId,
      amount: kopeksToRubles(input.amountKopeks).toFixed(2),
      order_id: input.orderId,
      currency_in: "RUB",
      type: "normal",
      payment_method: input.method === "card" ? "BANK_CARD" : "SBP",
      ttl: ttlMin * 60, // API ждёт секунды
    };
    if (input.successUrl) form.success_url = input.successUrl;
    if (input.failUrl) form.fail_url = input.failUrl;
    if (input.description) form.description = input.description;

    const res = await request<Record<string, unknown>>(`${apiUrl}/bill/create`, {
      method: "POST",
      provider: "pal24",
      form,
      headers: { authorization: `Bearer ${token}` },
    });

    const body = res.body ?? {};
    if (!body.success) throw new Error(`pal24: ${JSON.stringify(body).slice(0, 200)}`);

    return {
      // Pal24 присылает наш order_id в поле InvId — по нему и ищем
      providerPaymentId: input.orderId,
      providerRef: body.bill_id ? String(body.bill_id) : undefined,
      payUrl: (body.link_page_url ?? body.link_url) as string | undefined,
      raw: body,
    };
  },

  verifyWebhook(merchant, req: WebhookRequest): boolean {
    const token = merchant.credentials.token;
    if (!token) return false;
    const form = new URLSearchParams(req.rawBody);
    const outSum = form.get("OutSum");
    const invId = form.get("InvId");
    const provided = form.get("SignatureValue");
    if (!outSum || !invId || !provided) return false;
    return safeCompare(signPal24Postback(outSum, invId, token), provided.toUpperCase());
  },

  parseWebhook(_merchant, req: WebhookRequest): ParsedWebhook {
    const form = new URLSearchParams(req.rawBody);
    const outSum = form.get("OutSum");
    return {
      providerPaymentId: form.get("InvId") ?? "",
      providerRef: form.get("TrsId") ?? undefined,
      status: mapStatus(form.get("Status") ?? ""),
      amountKopeks: outSum ? Math.round(Number(outSum) * 100) : undefined,
      raw: Object.fromEntries(form.entries()),
    };
  },

  async healthCheck(merchant) {
    const apiUrl = settingString(merchant, "api_url", "https://pal24.pro/api/v1").replace(/\/+$/, "");
    const token = requireCredential(merchant, "token");
    try {
      const res = await request<Record<string, unknown>>(`${apiUrl}/merchant/balance`, {
        method: "GET",
        provider: "pal24",
        headers: { authorization: `Bearer ${token}` },
        retries: 0,
      });
      return { ok: res.status === 200, detail: JSON.stringify(res.body ?? {}).slice(0, 200) };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
};

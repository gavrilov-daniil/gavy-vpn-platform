import { createHmac, timingSafeEqual } from "node:crypto";
import { request } from "@corelink/core-kit";
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

/** Подпись OxaPay: HMAC-SHA512(merchant_api_key, rawBody) → hex, заголовок `hmac`. */
export function verifyOxaPaySignature(apiKey: string, rawBody: string, signatureHex: string): boolean {
  const sig = signatureHex.trim();
  if (!sig) return false;
  const expected = createHmac("sha512", apiKey).update(Buffer.from(rawBody, "utf8")).digest("hex");
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

function mapStatus(raw: string): PaymentStatus {
  switch (raw.toLowerCase()) {
    case "paid":
      return "paid";
    case "waiting":
    case "confirming":
      return "processing";
    case "expired":
      return "expired";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

export const oxapayAdapter: PaymentAdapter = {
  provider: "oxapay",
  // в проде был только topup; здесь ограничение честно объявлено контрактом
  supportedPurposes: ["topup"],

  isConfigured(merchant) {
    return Boolean(merchant.credentials.merchant_api_key);
  },

  async createInvoice(merchant: MerchantConfig, input: CreateInvoiceInput): Promise<CreatedInvoice> {
    const apiUrl = resolveProviderBaseUrl(merchant);
    const apiKey = requireCredential(merchant, "merchant_api_key");
    const ttlMin = settingNumber(merchant, "invoice_ttl_min", 30);

    const res = await request<{ status?: number; data?: Record<string, unknown> }>(`${apiUrl}/payment/invoice`, {
      method: "POST",
      provider: "oxapay",
      headers: { merchant_api_key: apiKey },
      json: {
        amount: kopeksToRubles(input.amountKopeks),
        currency: "RUB",
        order_id: input.orderId,
        lifetime: ttlMin,
        fee_paid_by_payer: 1,
        callback_url: input.callbackUrl,
        return_url: input.successUrl,
        description: input.description,
      },
    });

    const data = res.body?.data;
    if (!data?.track_id) throw new Error(`oxapay: пустой ответ ${JSON.stringify(res.body ?? {}).slice(0, 200)}`);

    return {
      providerPaymentId: String(data.track_id),
      providerRef: String(data.track_id),
      payUrl: data.payment_url as string | undefined,
      expiresAt: data.expired_at ? new Date(Number(data.expired_at) * 1000) : undefined,
      raw: data,
    };
  },

  verifyWebhook(merchant, req: WebhookRequest): boolean {
    const apiKey = merchant.credentials.merchant_api_key;
    const provided = req.headers["hmac"];
    if (!apiKey || !provided) return false;
    return verifyOxaPaySignature(apiKey, req.rawBody, provided);
  },

  parseWebhook(_merchant, req: WebhookRequest): ParsedWebhook {
    const payload = JSON.parse(req.rawBody) as Record<string, unknown>;
    const txs = (payload.txs ?? []) as Array<Record<string, unknown>>;
    const tx = txs[0];
    return {
      providerPaymentId: String(payload.track_id ?? ""),
      providerRef: payload.track_id ? String(payload.track_id) : undefined,
      status: mapStatus(String(payload.status ?? "")),
      cryptoAsset: tx?.currency ? String(tx.currency) : undefined,
      cryptoNetwork: tx?.network ? String(tx.network) : undefined,
      cryptoAmount: tx?.received_amount ? String(tx.received_amount) : undefined,
      exchangeRate: tx?.rate ? String(tx.rate) : undefined,
      raw: payload,
    };
  },
};

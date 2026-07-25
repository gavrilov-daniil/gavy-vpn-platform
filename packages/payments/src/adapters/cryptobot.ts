import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { request } from "@vpn/core-kit";
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

const DEFAULT_ASSETS = ["USDT", "TON", "BTC"];

/** Подпись CryptoBot: secret = sha256(apiToken), затем HMAC-SHA256(secret, rawBody) → hex. */
export function verifyCryptoBotSignature(apiToken: string, rawBody: string, signatureHex: string): boolean {
  const secret = createHash("sha256").update(apiToken).digest();
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== signatureHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/** Точность крипто-сумм: BTC/ETH — 8 знаков, остальное — 6. */
export function formatCryptoAmount(amount: number, asset: string): string {
  const decimals = asset === "BTC" || asset === "ETH" ? 8 : 6;
  return amount.toFixed(decimals);
}

function mapStatus(raw: string): PaymentStatus {
  switch (raw) {
    case "paid":
      return "paid";
    case "expired":
      return "expired";
    case "active":
      return "pending";
    default:
      return "pending";
  }
}

export const cryptobotAdapter: PaymentAdapter = {
  provider: "cryptobot",
  supportedPurposes: ["topup", "plan", "gift"],

  isConfigured(merchant) {
    return Boolean(merchant.credentials.api_token);
  },

  async createInvoice(merchant: MerchantConfig, input: CreateInvoiceInput): Promise<CreatedInvoice> {
    const apiUrl = settingString(merchant, "api_url", "https://pay.crypt.bot/api").replace(/\/+$/, "");
    const apiToken = requireCredential(merchant, "api_token");
    const ttlSec = settingNumber(merchant, "invoice_ttl_sec", 1200);
    const asset = input.asset && DEFAULT_ASSETS.includes(input.asset) ? input.asset : "USDT";

    // фиксируем курс на момент создания счёта
    const rates = await request<{ result?: Array<{ source: string; target: string; rate: string }> }>(
      `${apiUrl}/getExchangeRates`,
      { method: "POST", provider: "cryptobot", headers: { "Crypto-Pay-API-Token": apiToken }, json: {} },
    );
    const rate = rates.body?.result?.find((r) => r.source === asset && r.target === "RUB");
    if (!rate) throw new Error(`cryptobot: не найден курс ${asset}/RUB`);

    const rubles = kopeksToRubles(input.amountKopeks);
    const cryptoAmount = formatCryptoAmount(rubles / Number(rate.rate), asset);

    const res = await request<{ ok?: boolean; result?: Record<string, unknown>; error?: unknown }>(
      `${apiUrl}/createInvoice`,
      {
        method: "POST",
        provider: "cryptobot",
        headers: { "Crypto-Pay-API-Token": apiToken },
        json: {
          currency_type: "crypto",
          asset,
          amount: cryptoAmount,
          expires_in: ttlSec,
          description: input.description,
          payload: JSON.stringify({ orderId: input.orderId, purpose: input.purpose }),
          allow_comments: false,
          allow_anonymous: true,
        },
      },
    );

    const invoice = res.body?.result;
    if (!invoice?.invoice_id) throw new Error(`cryptobot: ${JSON.stringify(res.body?.error ?? {}).slice(0, 200)}`);

    return {
      providerPaymentId: String(invoice.invoice_id),
      providerRef: String(invoice.invoice_id),
      payUrl: (invoice.pay_url ?? invoice.bot_invoice_url) as string | undefined,
      cryptoAsset: asset,
      cryptoAmount,
      exchangeRate: rate.rate,
      expiresAt: new Date(Date.now() + ttlSec * 1000),
      raw: invoice,
    };
  },

  verifyWebhook(merchant, req: WebhookRequest): boolean {
    const apiToken = merchant.credentials.api_token;
    const provided = req.headers["crypto-pay-api-signature"];
    if (!apiToken || !provided) return false;
    return verifyCryptoBotSignature(apiToken, req.rawBody, provided);
  },

  parseWebhook(_merchant, req: WebhookRequest): ParsedWebhook {
    const update = JSON.parse(req.rawBody) as Record<string, unknown>;
    const payload = (update.payload ?? {}) as Record<string, unknown>;
    return {
      providerPaymentId: String(payload.invoice_id ?? ""),
      providerRef: payload.invoice_id ? String(payload.invoice_id) : undefined,
      status: mapStatus(String(payload.status ?? "")),
      cryptoAsset: payload.asset ? String(payload.asset) : undefined,
      cryptoAmount: payload.amount ? String(payload.amount) : undefined,
      raw: update,
    };
  },

  async healthCheck(merchant) {
    const apiUrl = settingString(merchant, "api_url", "https://pay.crypt.bot/api").replace(/\/+$/, "");
    const apiToken = requireCredential(merchant, "api_token");
    try {
      const res = await request<{ ok?: boolean }>(`${apiUrl}/getMe`, {
        method: "POST",
        provider: "cryptobot",
        headers: { "Crypto-Pay-API-Token": apiToken },
        json: {},
        retries: 0,
      });
      return { ok: Boolean(res.body?.ok) };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
};

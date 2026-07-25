import { cryptobotAdapter } from "./adapters/cryptobot.js";
import { oxapayAdapter } from "./adapters/oxapay.js";
import { pal24Adapter } from "./adapters/pal24.js";
import { paritypayAdapter } from "./adapters/paritypay.js";
import { starsAdapter } from "./adapters/stars.js";
import { PaymentAdapterError, type PaymentAdapter, type PaymentProviderId } from "./types.js";

const ADAPTERS: Record<PaymentProviderId, PaymentAdapter> = {
  stars: starsAdapter,
  cryptobot: cryptobotAdapter,
  oxapay: oxapayAdapter,
  paritypay: paritypayAdapter,
  pal24: pal24Adapter,
};

export const SUPPORTED_PROVIDERS = Object.keys(ADAPTERS) as PaymentProviderId[];

export function getAdapter(provider: string): PaymentAdapter {
  const adapter = ADAPTERS[provider as PaymentProviderId];
  if (!adapter) {
    throw new PaymentAdapterError(`неизвестный провайдер: ${provider}`, "UNKNOWN_PROVIDER", 400);
  }
  return adapter;
}

/** Описание кредов провайдера — админка рисует форму по нему, а не по хардкоду. */
export interface ProviderSpec {
  provider: PaymentProviderId;
  title: string;
  credentialFields: Array<{ key: string; label: string; required: boolean }>;
  settingFields: Array<{ key: string; label: string; type: "number" | "string"; default?: string | number }>;
  purposes: readonly string[];
}

export const PROVIDER_SPECS: ProviderSpec[] = [
  {
    provider: "stars",
    title: "Telegram Stars",
    credentialFields: [],
    settingFields: [{ key: "stars_to_kopeks_rate", label: "Копеек за звезду", type: "number", default: 100 }],
    purposes: starsAdapter.supportedPurposes,
  },
  {
    provider: "paritypay",
    title: "ParityPay (СБП/карты)",
    credentialFields: [
      { key: "shop_id", label: "Shop ID", required: true },
      { key: "api_key", label: "API key", required: true },
      { key: "webhook_secret", label: "Webhook secret", required: true },
    ],
    settingFields: [
      { key: "api_url", label: "API URL", type: "string", default: "https://api.paritypay.ru" },
      { key: "invoice_ttl_min", label: "TTL счёта, мин", type: "number", default: 30 },
    ],
    purposes: paritypayAdapter.supportedPurposes,
  },
  {
    provider: "pal24",
    title: "Pal24 / Pally (СБП/карты)",
    credentialFields: [
      { key: "shop_id", label: "Shop ID", required: true },
      { key: "token", label: "Token", required: true },
    ],
    settingFields: [
      { key: "api_url", label: "API URL", type: "string", default: "https://pal24.pro/api/v1" },
      { key: "invoice_ttl_min", label: "TTL счёта, мин", type: "number", default: 30 },
    ],
    purposes: pal24Adapter.supportedPurposes,
  },
  {
    provider: "cryptobot",
    title: "CryptoBot (крипта)",
    credentialFields: [{ key: "api_token", label: "API token", required: true }],
    settingFields: [
      { key: "api_url", label: "API URL", type: "string", default: "https://pay.crypt.bot/api" },
      { key: "invoice_ttl_sec", label: "TTL счёта, сек", type: "number", default: 1200 },
    ],
    purposes: cryptobotAdapter.supportedPurposes,
  },
  {
    provider: "oxapay",
    title: "OxaPay (крипта)",
    credentialFields: [{ key: "merchant_api_key", label: "Merchant API key", required: true }],
    settingFields: [
      { key: "api_url", label: "API URL", type: "string", default: "https://api.oxapay.com/v1" },
      { key: "invoice_ttl_min", label: "TTL счёта, мин", type: "number", default: 30 },
    ],
    purposes: oxapayAdapter.supportedPurposes,
  },
];

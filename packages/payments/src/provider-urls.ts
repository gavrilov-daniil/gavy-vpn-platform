import type { MerchantConfig, PaymentProviderId } from "./types.js";

/**
 * Базовые URL провайдеров — константы кода, а не настройка мерчанта.
 * Раньше адаптеры брали хост из settings.api_url, который приезжал PATCH-ом от админки:
 * подменённый адрес уводил расшифрованный боевой токен на чужой сервер.
 *
 * Живёт отдельным файлом, а не в registry.ts: registry импортирует адаптеры,
 * адаптеры импортируют эту карту — через registry получился бы цикл.
 */
export const PROVIDER_BASE_URLS: Record<PaymentProviderId, string> = {
  // у Stars внешнего API нет: счёт выставляет бот через Telegram
  stars: "",
  paritypay: "https://api.paritypay.ru",
  pal24: "https://pal24.pro/api/v1",
  cryptobot: "https://pay.crypt.bot/api",
  oxapay: "https://api.oxapay.com/v1",
};

/**
 * Хосты, на которые провайдеру разрешено ходить. Переопределение api_url из настроек
 * принимается только если хост здесь есть — всё остальное игнорируется.
 */
export const PROVIDER_ALLOWED_HOSTS: Record<PaymentProviderId, readonly string[]> = {
  stars: [],
  paritypay: ["api.paritypay.ru"],
  pal24: ["pal24.pro"],
  // testnet-хост CryptoBot — единственная легальная причина переопределить URL
  cryptobot: ["pay.crypt.bot", "testnet-pay.crypt.bot"],
  oxapay: ["api.oxapay.com"],
};

export function isAllowedProviderApiUrl(provider: string, rawUrl: unknown): boolean {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return false;
  const allowed = PROVIDER_ALLOWED_HOSTS[provider as PaymentProviderId];
  if (!allowed || allowed.length === 0) return false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  // https://user:pass@allowed.host уводит креды в заголовок Authorization чужого прокси
  if (url.username.length > 0 || url.password.length > 0) return false;
  return allowed.includes(url.hostname.toLowerCase());
}

/** Базовый URL для вызова провайдера: константа, либо разрешённое переопределение из настроек. */
export function resolveProviderBaseUrl(merchant: MerchantConfig): string {
  const base = PROVIDER_BASE_URLS[merchant.provider];
  const override = merchant.settings.api_url;

  if (override === undefined || override === null || override === "") return trimTrailingSlash(base);
  if (isAllowedProviderApiUrl(merchant.provider, override)) return trimTrailingSlash(String(override));

  console.warn(
    `payments.api_url_rejected merchant=${merchant.id} provider=${merchant.provider}: хост вне allowlist, использую ${base}`,
  );
  return trimTrailingSlash(base);
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export type PaymentProviderId = "stars" | "cryptobot" | "oxapay" | "paritypay" | "pal24";

export type PaymentPurpose = "topup" | "plan" | "gift";

export type PaymentStatus =
  | "pending"
  | "processing"
  | "paid"
  | "expired"
  | "canceled"
  | "failed"
  | "refunded";

/** Конфигурация мерчанта из БД (креды уже расшифрованы вызывающим). */
export interface MerchantConfig {
  id: string;
  provider: PaymentProviderId;
  alias: string;
  mode: "live" | "test";
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
}

export interface CreateInvoiceInput {
  /** Наш идентификатор платежа — уходит провайдеру как order_id/payload. */
  orderId: string;
  amountKopeks: number;
  purpose: PaymentPurpose;
  description: string;
  /** Для крипты: желаемый актив (USDT/TON/BTC). */
  asset?: string;
  /** Метод для СБП-провайдеров: sbp | card. */
  method?: string;
  callbackUrl?: string;
  successUrl?: string;
  failUrl?: string;
  /** Telegram id плательщика — нужен Stars-адаптеру. */
  telegramUserId?: number;
}

export interface CreatedInvoice {
  /** Идентификатор, по которому платёж ищется при вебхуке (UNIQUE вместе с provider). */
  providerPaymentId: string;
  /** Внутренний id счёта у провайдера, если отличается от providerPaymentId. */
  providerRef?: string;
  payUrl?: string;
  expiresAt?: Date;
  cryptoAsset?: string;
  cryptoAmount?: string;
  exchangeRate?: string;
  /** Для Stars: счёт выставляет бот, а не HTTP-вызов. */
  deferredToBot?: { payload: string; amountStars: number };
  raw?: unknown;
}

export interface WebhookRequest {
  /** Сырое тело — подпись считается по байтам, не по ре-сериализованному JSON. */
  rawBody: string;
  headers: Record<string, string>;
}

export interface ParsedWebhook {
  /** По какому значению искать платёж в БД. */
  providerPaymentId: string;
  providerRef?: string;
  status: PaymentStatus;
  amountKopeks?: number;
  cryptoAsset?: string;
  cryptoNetwork?: string;
  cryptoAmount?: string;
  exchangeRate?: string;
  raw: unknown;
}

export class PaymentAdapterError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 400) {
    super(message);
    this.name = "PaymentAdapterError";
  }
}

/**
 * Честная абстракция платёжного провайдера.
 * В проде интерфейс был заточен под Stars и его реализовывал ровно один класс —
 * остальные четыре жили мимо. Здесь контракт покрывает все пять.
 */
export interface PaymentAdapter {
  readonly provider: PaymentProviderId;
  /** Какие назначения поддерживает провайдер (oxapay в проде умел только topup). */
  readonly supportedPurposes: readonly PaymentPurpose[];
  /** Хватает ли кредов. Провайдер без ключей не роняет старт, а не даёт создать счёт. */
  isConfigured(merchant: MerchantConfig): boolean;
  createInvoice(merchant: MerchantConfig, input: CreateInvoiceInput): Promise<CreatedInvoice>;
  /** Проверка подписи. Невалидная → 401 ДО всякой обработки. */
  verifyWebhook(merchant: MerchantConfig, req: WebhookRequest): boolean;
  parseWebhook(merchant: MerchantConfig, req: WebhookRequest): ParsedWebhook;
  /** Проверка связи/ключей для админки (кнопка «Проверить»). */
  healthCheck?(merchant: MerchantConfig): Promise<{ ok: boolean; detail?: string }>;
}

export function requireCredential(merchant: MerchantConfig, key: string): string {
  const value = merchant.credentials[key];
  if (!value) {
    throw new PaymentAdapterError(
      `${merchant.provider}: не задан ключ ${key}`,
      `${merchant.provider.toUpperCase()}_NOT_CONFIGURED`,
      400,
    );
  }
  return value;
}

export function settingNumber(merchant: MerchantConfig, key: string, fallback: number): number {
  const raw = merchant.settings[key];
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function settingString(merchant: MerchantConfig, key: string, fallback: string): string {
  const raw = merchant.settings[key];
  return typeof raw === "string" && raw.length > 0 ? raw : fallback;
}

export const kopeksToRubles = (kopeks: number): number => Math.round(kopeks) / 100;

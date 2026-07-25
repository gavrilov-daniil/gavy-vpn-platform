import { pgTable, uuid, text, bigint, integer, boolean, timestamp, jsonb, numeric, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createdAt, orgId, updatedAt } from "./_shared.js";
import { subscriber, subscription } from "./subscribers.js";
import { server } from "./infra.js";

/**
 * Мерчант — подключённый платёжный аккаунт. Управляется ЧЕРЕЗ АДМИНКУ, не через env.
 * Главное отличие от прода gavy-vpn, где ключи в env и смена требует рестарта.
 * Даёт: несколько аккаунтов одного провайдера (A/B, разные юрлица, failover при блокировке),
 * включение/выключение без деплоя, test/live режим.
 */
export const paymentMerchant = pgTable("payment_merchant", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  provider: text("provider").notNull(), // stars | cryptobot | oxapay | paritypay | pal24
  alias: text("alias").notNull(), // человекочитаемое имя в админке
  isEnabled: boolean("is_enabled").notNull().default(false),
  mode: text("mode").notNull().default("live"), // live | test
  priority: integer("priority").notNull().default(0), // порядок в UI и выбор при failover
  // Ключи провайдера. Шифруются приложением (ключ в env/vault), в открытом виде не лежат.
  credentials: jsonb("credentials").$type<Record<string, string>>().notNull().default({}),
  // Некритичные настройки: ttl инвойса, поддерживаемые активы, лимиты, метод (sbp/card)
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  purposes: jsonb("purposes").$type<string[]>().notNull().default(["topup", "plan"]),
  title: text("title"), // подпись кнопки в боте («СБП», «Крипта»)
  lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
  lastCheckOk: boolean("last_check_ok"),
  lastCheckError: text("last_check_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("payment_merchant_org_alias_uq").on(t.orgId, t.alias)]);

export const plan = pgTable("plan", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  code: text("code").notNull(),
  title: text("title").notNull(),
  periodDays: integer("period_days").notNull(),
  priceKopeks: bigint("price_kopeks", { mode: "number" }).notNull(),
  trafficGb: integer("traffic_gb"),
  deviceLimit: integer("device_limit"),
  isTrial: boolean("is_trial").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  squadIds: jsonb("squad_ids").$type<string[]>().notNull().default([]),
}, (t) => [uniqueIndex("plan_org_code_uq").on(t.orgId, t.code)]);

/**
 * Платёж. Идемпотентность вебхука — UNIQUE(org, provider, provider_payment_id).
 * Назначение — ТИПИЗОВАННЫЕ колонки (purpose/plan_id/provider_ref), не meta-JSON:
 * в проде россыпь extract*(meta) дублировалась в каждом flow-сервисе.
 * meta оставлена только под сырой ответ провайдера (аудит).
 */
export const payment = pgTable("payment", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  subscriberId: uuid("subscriber_id").notNull().references(() => subscriber.id),
  merchantId: uuid("merchant_id").references(() => paymentMerchant.id),
  provider: text("provider").notNull(),
  providerPaymentId: text("provider_payment_id").notNull(),
  providerRef: text("provider_ref"), // id счёта у провайдера (invoice_id/bill_id/track_id)

  purpose: text("purpose").notNull().default("topup"), // topup | plan | gift
  planId: uuid("plan_id").references(() => plan.id),
  giftToken: text("gift_token"),

  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(),
  currency: text("currency").notNull().default("RUB"),
  status: text("status").notNull().default("pending"), // pending|processing|paid|expired|canceled|failed|refunded

  cryptoAsset: text("crypto_asset"),
  cryptoNetwork: text("crypto_network"),
  cryptoAmount: numeric("crypto_amount", { precision: 30, scale: 10 }),
  exchangeRate: numeric("exchange_rate", { precision: 20, scale: 8 }),
  rateLockedAt: timestamp("rate_locked_at", { withTimezone: true }),

  expiresAt: timestamp("expires_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  isFirstPaid: boolean("is_first_paid").notNull().default(false),
  campaignLinkId: uuid("campaign_link_id"), // snapshot источника трафика

  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("payment_provider_uq").on(t.orgId, t.provider, t.providerPaymentId),
  index("payment_subscriber_idx").on(t.subscriberId, t.createdAt),
  uniqueIndex("payment_gift_token_uq").on(t.giftToken),
]);

// APPEND-ONLY. Баланс = SUM(amount_kopeks). Строки не правятся, поля balance нет.
export const ledgerEntry = pgTable("ledger_entry", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  subscriberId: uuid("subscriber_id").notNull().references(() => subscriber.id),
  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(), // знаковое: purchase = −price
  entryType: text("entry_type").notNull(), // topup | purchase | refund | bonus | referral
  paymentId: uuid("payment_id").references(() => payment.id),
  subscriptionId: uuid("subscription_id").references(() => subscription.id),
  description: text("description"),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("ledger_idempotency_uq").on(t.idempotencyKey),
  index("ledger_subscriber_idx").on(t.subscriberId, t.createdAt),
]);

// Guard от лишних дней при повторном вебхуке: один платёж — одна активация.
export const subscriptionActivation = pgTable("subscription_activation", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  subscriptionId: uuid("subscription_id").notNull().references(() => subscription.id),
  paymentId: uuid("payment_id").notNull().references(() => payment.id),
  planId: uuid("plan_id").references(() => plan.id),
  action: text("action").notNull().default("extended"), // created | extended | replaced
  addedDays: integer("added_days").notNull(),
  newExpireAt: timestamp("new_expire_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("sub_activation_payment_uq").on(t.paymentId)]);

export const promoCode = pgTable("promo_code", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  code: text("code").notNull(),
  kind: text("kind").notNull().default("percent"), // percent | fixed | days
  value: integer("value").notNull(),
  maxRedemptions: integer("max_redemptions"),
  redeemedCount: integer("redeemed_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [uniqueIndex("promo_code_uq").on(t.orgId, t.code)]);

export const promoRedemption = pgTable("promo_redemption", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  promoCodeId: uuid("promo_code_id").notNull().references(() => promoCode.id),
  subscriberId: uuid("subscriber_id").notNull().references(() => subscriber.id),
  paymentId: uuid("payment_id").references(() => payment.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("promo_redemption_uq").on(t.promoCodeId, t.subscriberId)]);

export const referral = pgTable("referral", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  referrerSubscriberId: uuid("referrer_subscriber_id").notNull().references(() => subscriber.id),
  referredSubscriberId: uuid("referred_subscriber_id").notNull().references(() => subscriber.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("referral_uq").on(t.referredSubscriberId)]);

/**
 * Реф-награда с антифрод-выдержкой (проверенная механика прода):
 * pending_refund_window (окно возврата) → pending_hold (антифрод) → available (создаётся ledger-запись).
 */
export const referralReward = pgTable("referral_reward", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  referrerSubscriberId: uuid("referrer_subscriber_id").notNull().references(() => subscriber.id),
  paymentId: uuid("payment_id").notNull().references(() => payment.id),
  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(),
  status: text("status").notNull().default("pending_refund_window"),
  refundWindowUntil: timestamp("refund_window_until", { withTimezone: true }),
  availableAt: timestamp("available_at", { withTimezone: true }),
  creditedAt: timestamp("credited_at", { withTimezone: true }),
  revertedAt: timestamp("reverted_at", { withTimezone: true }),
  revertReason: text("revert_reason"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("referral_reward_payment_uq").on(t.paymentId)]);

// Аудит исходящих HTTP-вызовов (секреты маскируются на записи).
export const externalApiLog = pgTable("external_api_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  provider: text("provider").notNull(),
  endpoint: text("endpoint").notNull(),
  method: text("method").notNull(),
  requestBody: jsonb("request_body"),
  responseBody: jsonb("response_body"),
  statusCode: integer("status_code"),
  durationMs: integer("duration_ms"),
  attempts: integer("attempts").notNull().default(1),
  correlationId: text("correlation_id"),
  errorMessage: text("error_message"),
  createdAt: createdAt(),
}, (t) => [index("external_api_log_provider_idx").on(t.provider, t.createdAt)]);

// --- Учёт инфраструктуры (расходы на серверы/домены) ---
export const infraProvider = pgTable("infra_provider", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  name: text("name").notNull(),
  kind: text("kind"), // vps | domain | license | cdn
  accountRef: text("account_ref"),
  notes: text("notes"),
});

export const infraResource = pgTable("infra_resource", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  providerId: uuid("provider_id").references(() => infraProvider.id),
  serverId: uuid("server_id").references(() => server.id),
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  monthlyCostKopeks: bigint("monthly_cost_kopeks", { mode: "number" }),
  currency: text("currency").notNull().default("RUB"),
  billingPeriod: text("billing_period").notNull().default("month"),
  nextRenewalAt: timestamp("next_renewal_at", { withTimezone: true }),
  autoRenew: boolean("auto_renew").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
});

export const infraPayment = pgTable("infra_payment", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  resourceId: uuid("resource_id").notNull().references(() => infraResource.id),
  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(),
  currency: text("currency").notNull().default("RUB"),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull(),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }),
}, (t) => [uniqueIndex("infra_payment_uq").on(t.resourceId, t.periodStart)]);

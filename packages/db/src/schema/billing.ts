import { pgTable, uuid, text, bigint, integer, boolean, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, orgId } from "./_shared.js";
import { subscriber, subscription } from "./subscribers.js";
import { server } from "./infra.js";

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
}, (t) => [uniqueIndex("plan_org_code_uq").on(t.orgId, t.code)]);

// Платёж. Идемпотентность вебхука — на unique(provider, provider_payment_id).
export const payment = pgTable("payment", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  subscriberId: uuid("subscriber_id").notNull().references(() => subscriber.id),
  provider: text("provider").notNull(), // telegram_stars | cryptobot | cryptomus | ...
  providerPaymentId: text("provider_payment_id").notNull(),
  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(),
  currency: text("currency").notNull().default("XTR"),
  status: text("status").notNull().default("pending"), // pending | paid | failed | refunded
  rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull().default({}),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("payment_provider_uq").on(t.orgId, t.provider, t.providerPaymentId)]);

// APPEND-ONLY. Баланс = SUM(amount_kopeks). Строки не правятся.
export const ledgerEntry = pgTable("ledger_entry", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  subscriberId: uuid("subscriber_id").notNull().references(() => subscriber.id),
  amountKopeks: bigint("amount_kopeks", { mode: "number" }).notNull(), // + пополнение / − списание
  entryType: text("entry_type").notNull(), // topup | charge | refund | bonus | referral
  refType: text("ref_type"),
  refId: uuid("ref_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("ledger_idempotency_uq").on(t.idempotencyKey)]);

// Активация/продление подписки платежом. Guard от лишних дней при повторном вебхуке.
export const subscriptionActivation = pgTable("subscription_activation", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  subscriptionId: uuid("subscription_id").notNull().references(() => subscription.id),
  paymentId: uuid("payment_id").notNull().references(() => payment.id),
  planId: uuid("plan_id").references(() => plan.id),
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

export const referral = pgTable("referral", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  referrerSubscriberId: uuid("referrer_subscriber_id").notNull().references(() => subscriber.id),
  referredSubscriberId: uuid("referred_subscriber_id").notNull().references(() => subscriber.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("referral_uq").on(t.referredSubscriberId)]);

// --- Учёт инфраструктуры (юнит-экономика) ---
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
  kind: text("kind").notNull(), // vps | domain | license
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

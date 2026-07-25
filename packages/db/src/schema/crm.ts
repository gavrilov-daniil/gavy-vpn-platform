import { pgTable, uuid, text, bigint, integer, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createdAt, orgId, updatedAt } from "./_shared.js";
import { subscriber } from "./subscribers.js";

/**
 * ВАЖНО про терминологию (в проде две сущности звались «campaign», это путало):
 *   campaign / campaign_link / campaign_event — ПРОМО-ТРЕКИНГ источников трафика (attribution).
 *   broadcast / touchpoint                    — РАССЫЛКИ и триггерные касания.
 */

export const campaign = pgTable("campaign", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  channel: text("channel"), // tg_channel | vk_post | vk_ads | dm | ...
  status: text("status").notNull().default("active"), // active | paused | finished
  costKopeks: bigint("cost_kopeks", { mode: "number" }).notNull().default(0), // для ROI
  createdAt: createdAt(),
}, (t) => [uniqueIndex("campaign_slug_uq").on(t.orgId, t.slug)]);

/**
 * Ссылка кампании: t.me/<bot>?start=c_<CODE>.
 * code — Crockford base32 без 0/O/1/I/L, 4-6 символов (не путается при наборе с рекламы).
 * Счётчики денормализованы для быстрого UI; источник истины — campaign_event.
 */
export const campaignLink = pgTable("campaign_link", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  campaignId: uuid("campaign_id").notNull().references(() => campaign.id),
  code: text("code").notNull(),
  label: text("label"),
  isArchived: boolean("is_archived").notNull().default(false),
  registrations: integer("registrations").notNull().default(0),
  payingUsers: integer("paying_users").notNull().default(0),
  revenueKopeks: bigint("revenue_kopeks", { mode: "number" }).notNull().default(0),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("campaign_link_code_uq").on(t.code)]);

/**
 * Append-only лог атрибуции. Идемпотентность — partial unique индексами (в миграции):
 *   registration: UNIQUE(subscriber_id, campaign_link_id) WHERE type='registration'
 *   payment:      UNIQUE(payment_id) WHERE type='payment'
 * Атрибуция first-touch: subscriber.campaign_link_id пишется при создании и НЕ перезаписывается.
 */
export const campaignEvent = pgTable("campaign_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  campaignLinkId: uuid("campaign_link_id").notNull().references(() => campaignLink.id),
  subscriberId: uuid("subscriber_id").references(() => subscriber.id),
  paymentId: uuid("payment_id"),
  type: text("type").notNull(), // registration | payment
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index("campaign_event_link_idx").on(t.campaignLinkId, t.createdAt)]);

/**
 * Продуктовая аналитика из бота. update_id — дедуп повторной доставки вебхука.
 * Без FK на subscriber: первое событие /start приходит раньше создания подписчика.
 */
export const botEvent = pgTable("bot_event", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }),
  subscriberId: uuid("subscriber_id"),
  event: text("event").notNull(),
  updateId: bigint("update_id", { mode: "number" }),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("bot_event_update_uq").on(t.updateId),
  index("bot_event_type_idx").on(t.orgId, t.event, t.createdAt),
]);

// Сегмент — правило выборки подписчиков (декларативный предикат, интерпретируется в SQL).
export const segment = pgTable("segment", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("rule"), // rule | manual
  predicate: jsonb("predicate").$type<Record<string, unknown>>().notNull().default({}),
  isMarketing: boolean("is_marketing").notNull().default(true),
  createdAt: createdAt(),
});

// Рассылка. Материализуется в broadcast_recipient — возобновляема после падения воркера.
export const broadcast = pgTable("broadcast", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  title: text("title").notNull(),
  segmentKind: text("segment_kind").notNull().default("all"), // all | active | inactive | expiring | segment
  segmentId: uuid("segment_id").references(() => segment.id),
  bodyHtml: text("body_html").notNull(),
  imageFileId: text("image_file_id"), // file_id Telegram — переиспользуется, не перезаливаем фото
  buttons: jsonb("buttons").$type<Record<string, unknown>[]>().notNull().default([]),
  status: text("status").notNull().default("draft"), // draft | scheduled | running | done | canceled
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  throttlePerSec: integer("throttle_per_sec").notNull().default(20),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const broadcastRecipient = pgTable("broadcast_recipient", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  broadcastId: uuid("broadcast_id").notNull().references(() => broadcast.id),
  subscriberId: uuid("subscriber_id").notNull().references(() => subscriber.id),
  status: text("status").notNull().default("pending"), // pending | sent | failed | skipped
  reason: text("reason"), // blocked | rate_limited | error
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => [uniqueIndex("broadcast_recipient_uq").on(t.broadcastId, t.subscriberId)]);

/**
 * Триггерное касание (drip/lifecycle) — «дожим» продажи.
 * trigger_type: event (по событию) | schedule (по расписанию) | condition (по состоянию подписки).
 */
export const touchpoint = pgTable("touchpoint", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  name: text("name").notNull(),
  triggerType: text("trigger_type").notNull(),
  triggerKey: text("trigger_key").notNull(), // trial_started | expires_in_3d | churned_7d | ...
  delayHours: integer("delay_hours").notNull().default(0),
  bodyHtml: text("body_html").notNull(),
  buttons: jsonb("buttons").$type<Record<string, unknown>[]>().notNull().default([]),
  quietHours: jsonb("quiet_hours").$type<{ from: number; to: number }>(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
});

/**
 * Лог отправок. dedup_key не даёт задвоить касание/рассылку.
 * Для broadcast в ключ входит run_id (повторный ручной запуск — это новая отправка).
 */
/**
 * Дедуп служебных действий джоб (алерты операторам, разовые уведомления).
 * Отдельно от message_log: там subscriber_id NOT NULL, а у алерта оператору
 * подписчика нет. Раньше дедуп жил только в Redis — без него алерт повторялся
 * каждые 5 минут, а при отсутствии Redis дедупа не было вовсе.
 */
export const jobDedup = pgTable("job_dedup", {
  key: text("key").primaryKey(),
  orgId: orgId(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index("job_dedup_kind_idx").on(t.orgId, t.kind, t.createdAt)]);

export const messageLog = pgTable("message_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  subscriberId: uuid("subscriber_id").notNull().references(() => subscriber.id),
  kind: text("kind").notNull(), // broadcast | touchpoint | transactional
  refId: uuid("ref_id"),
  dedupKey: text("dedup_key").notNull(),
  status: text("status").notNull().default("sent"), // sent | failed | skipped
  telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
  error: text("error"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("message_log_dedup_uq").on(t.dedupKey),
  index("message_log_subscriber_idx").on(t.subscriberId, t.createdAt),
]);

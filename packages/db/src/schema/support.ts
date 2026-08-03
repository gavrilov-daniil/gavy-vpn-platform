import { pgTable, uuid, text, bigint, boolean, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createdAt, orgId, updatedAt } from "./_shared.js";
import { subscriber } from "./subscribers.js";
import { user } from "./tenancy.js";

// Контакт в Telegram (может ещё не быть подписчиком — пишет до покупки).
export const supportContact = pgTable("support_contact", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  subscriberId: uuid("subscriber_id").references(() => subscriber.id),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
  username: text("username"),
  languageCode: text("language_code"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("support_contact_uq").on(t.orgId, t.telegramUserId)]);

// Диалог = тикет. Открытый диалог у контакта один (partial unique добавляется миграцией).
export const conversation = pgTable("conversation", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  contactId: uuid("contact_id").notNull().references(() => supportContact.id),
  channel: text("channel").notNull().default("telegram"),
  status: text("status").notNull().default("open"), // open | pending | resolved | closed
  assigneeUserId: uuid("assignee_user_id").references(() => user.id),
  aiMode: text("ai_mode").notNull().default("suggest"), // off | suggest | auto
  priority: text("priority").notNull().default("normal"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("conversation_status_idx").on(t.orgId, t.status, t.lastMessageAt)]);

/**
 * Сообщение. Два ключа идемпотентности:
 *  telegram_update_id — дедуп ВХОДЯЩИХ (повторная доставка вебхука Telegram);
 *  dedup_key          — дедуп ИСХОДЯЩИХ (повторная постановка джобы отправки).
 */
export const message = pgTable("message", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  conversationId: uuid("conversation_id").notNull().references(() => conversation.id),
  senderType: text("sender_type").notNull(), // contact | operator | ai | system
  senderUserId: uuid("sender_user_id").references(() => user.id),
  direction: text("direction").notNull(), // in | out
  content: text("content").notNull(),
  attachments: jsonb("attachments").$type<Record<string, unknown>[]>().notNull().default([]),
  telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
  telegramUpdateId: bigint("telegram_update_id", { mode: "number" }),
  dedupKey: text("dedup_key"),
  deliveryStatus: text("delivery_status").notNull().default("pending"), // pending | sent | failed
  error: text("error"),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("message_tg_update_uq").on(t.telegramUpdateId),
  uniqueIndex("message_dedup_uq").on(t.dedupKey),
  index("message_conversation_idx").on(t.conversationId, t.createdAt),
]);

/**
 * Подключённый провайдер ИИ. Управляется ЧЕРЕЗ АДМИНКУ, как payment_merchant:
 * ключ шифруется при записи, тумблер включает провайдера без рестарта.
 * В env ключи не кладём — иначе смена ключа означает выкатку.
 */
export const aiProvider = pgTable("ai_provider", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  provider: text("provider").notNull(), // anthropic | openai_compatible
  alias: text("alias").notNull(),
  isEnabled: boolean("is_enabled").notNull().default(false),
  model: text("model").notNull(),
  credentials: jsonb("credentials").$type<Record<string, string>>().notNull().default({}),
  // Лимиты расхода и длины контекста живут здесь: их правит оператор, а не деплой.
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
  lastCheckOk: boolean("last_check_ok"),
  lastCheckError: text("last_check_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("ai_provider_org_alias_uq").on(t.orgId, t.alias)]);

// База знаний для ИИ-ответов. Векторный поиск — позже (pgvector не в MVP, 1GB RAM).
export const kbDocument = pgTable("kb_document", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  source: text("source"),
  lang: text("lang").notNull().default("ru"),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: updatedAt(),
});

export const aiSuggestion = pgTable("ai_suggestion", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  conversationId: uuid("conversation_id").notNull().references(() => conversation.id),
  messageId: uuid("message_id").references(() => message.id),
  model: text("model"),
  content: text("content").notNull(),
  retrievedDocIds: jsonb("retrieved_doc_ids").$type<string[]>().notNull().default([]),
  status: text("status").notNull().default("proposed"), // proposed | accepted | edited | rejected | sent
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex("ai_suggestion_idempotency_uq").on(t.idempotencyKey),
  index("ai_suggestion_conversation_idx").on(t.orgId, t.conversationId, t.createdAt),
]);

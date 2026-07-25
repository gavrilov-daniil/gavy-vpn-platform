import { pgTable, uuid, text, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, orgId } from "./_shared.js";

// Корень tenant'а. Деплой для своей сети = одна строка (org #1).
export const organization = pgTable("organization", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"), // active | suspended
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("organization_slug_uq").on(t.slug)]);

// АДМИН панели (оператор/админ). НЕ путать с subscriber (конечный VPN-юзер).
export const user = pgTable("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  email: text("email").notNull(),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("operator"), // owner | admin | operator
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("user_org_email_uq").on(t.orgId, t.email)]);

export const apiToken = pgTable("api_token", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  role: text("role").notNull().default("api"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("api_token_hash_uq").on(t.tokenHash)]);

/**
 * Сессия оператора админки. Пароль в браузере не храним — только случайный
 * токен, и тот в БД лежит хешем: утечка дампа не должна давать готовые сессии.
 */
export const operatorSession = pgTable("operator_session", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  userId: uuid("user_id").notNull().references(() => user.id),
  tokenHash: text("token_hash").notNull(),
  userAgent: text("user_agent"),
  ip: text("ip"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("operator_session_token_uq").on(t.tokenHash)]);

import { pgTable, uuid, text, bigint, integer, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, orgId, updatedAt } from "./_shared.js";

// Конечный VPN-пользователь (обычно = Telegram-аккаунт).
export const subscriber = pgTable("subscriber", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  telegramId: bigint("telegram_id", { mode: "number" }),
  username: text("username"),
  email: text("email"),
  status: text("status").notNull().default("active"),
  marketingOptOut: boolean("marketing_opt_out").notNull().default(false),
  tgBlocked: boolean("tg_blocked").notNull().default(false),
  description: text("description"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("subscriber_org_tg_uq").on(t.orgId, t.telegramId)]);

// Доступ + лимиты + идентичность в конфиге.
// МИГРАЦИЯ: short_uuid / vless_uuid импортируются VERBATIM, не регенерятся (migration.md P0-3).
export const subscription = pgTable("subscription", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  subscriberId: uuid("subscriber_id").notNull().references(() => subscriber.id),

  // публичный неугадываемый идентификатор в URL подписки; меняется ТОЛЬКО при revoke
  shortUuid: text("short_uuid").notNull(),

  status: text("status").notNull().default("active"), // trial | active | expired | suspended | disabled
  expireAt: timestamp("expire_at", { withTimezone: true }),

  trafficLimitBytes: bigint("traffic_limit_bytes", { mode: "number" }),
  trafficLimitStrategy: text("traffic_limit_strategy").notNull().default("month"), // month | day | no_reset
  usedTrafficBytes: bigint("used_traffic_bytes", { mode: "number" }).notNull().default(0), // КЭШ-роллап; истина в traffic_sample
  lifetimeUsedBytes: bigint("lifetime_used_bytes", { mode: "number" }).notNull().default(0),
  lastTrafficResetAt: timestamp("last_traffic_reset_at", { withTimezone: true }),

  hwidDeviceLimit: integer("hwid_device_limit"),

  // идентичность юзера в Xray-конфиге (per-client секреты)
  vlessUuid: uuid("vless_uuid").notNull(),
  trojanPassword: text("trojan_password"),
  ssPassword: text("ss_password"),

  subRevokedAt: timestamp("sub_revoked_at", { withTimezone: true }),
  subLastUserAgent: text("sub_last_user_agent"),
  subLastOpenedAt: timestamp("sub_last_opened_at", { withTimezone: true }),
  onlineAt: timestamp("online_at", { withTimezone: true }),

  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("subscription_org_short_uuid_uq").on(t.orgId, t.shortUuid)]);

// HWID-устройства. Идемпотентность device-limit — на unique index, не check-then-act (GHSA-паттерн).
export const subscriberDevice = pgTable("subscriber_device", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  subscriptionId: uuid("subscription_id").notNull().references(() => subscription.id),
  hwid: text("hwid").notNull(),
  deviceOs: text("device_os"),
  osVer: text("os_ver"),
  deviceModel: text("device_model"),
  userAgent: text("user_agent"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("subscriber_device_sub_hwid_uq").on(t.subscriptionId, t.hwid)]);

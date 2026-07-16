import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, orgId } from "./_shared.js";
import { subscription } from "./subscribers.js";
import { node } from "./infra.js";

export const abuseSignal = pgTable("abuse_signal", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  subscriptionId: uuid("subscription_id").references(() => subscription.id),
  nodeId: uuid("node_id").references(() => node.id),
  kind: text("kind").notNull(), // volume | ratio | ip_fanout | torrent
  severity: integer("severity").notNull().default(1),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
});

// Действие идемпотентно по idempotency_key = kind:sub_id:date_bucket (детект ×3 → одно действие).
export const abuseAction = pgTable("abuse_action", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  subscriptionId: uuid("subscription_id").notNull().references(() => subscription.id),
  action: text("action").notNull(), // warn | throttle | suspend
  reason: text("reason"),
  idempotencyKey: text("idempotency_key").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => [uniqueIndex("abuse_action_idempotency_uq").on(t.idempotencyKey)]);

export const torrentBan = pgTable("torrent_ban", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  nodeId: uuid("node_id").notNull().references(() => node.id),
  ip: text("ip").notNull(),
  bannedAt: timestamp("banned_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => [uniqueIndex("torrent_ban_uq").on(t.nodeId, t.ip, t.bannedAt)]);

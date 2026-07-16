import { timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * SaaS-ready без магии: org_id — явная колонка на каждой таблице.
 * Никаких глобальных скоупов / RLS в MVP — фильтр org_id проставляется явно в запросах.
 * RLS вводим при первом реальном org #2 (ADR-3).
 */
export const orgId = () =>
  uuid("org_id")
    .notNull()
    .default("00000000-0000-0000-0000-000000000001");

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

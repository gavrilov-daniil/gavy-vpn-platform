-- Per-node секрет агента вместо общего AGENT_TOKEN на весь парк.
--
-- Общий токен означал, что изъятая нода (а они стоят у разных хостеров и в РФ)
-- отдаёт desired-state ЛЮБОЙ другой ноды: short_uuid и vless_uuid всех клиентов,
-- адреса, ключи. Теперь у каждой ноды свой токен, выданный при энроллменте.
--
-- Хранится только sha256-хеш: дамп БД не даёт токена. Unique-индекс — часть
-- логики, а не оптимизация: два разных node_identity с одинаковым хешем сделали бы
-- аутентификацию неоднозначной.
ALTER TABLE "node_identity" ADD COLUMN IF NOT EXISTS "agent_token_hash" text;--> statement-breakpoint
ALTER TABLE "node_identity" ADD COLUMN IF NOT EXISTS "agent_token_issued_at" timestamp with time zone;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "node_identity_agent_token_uq" ON "node_identity" USING btree ("agent_token_hash");

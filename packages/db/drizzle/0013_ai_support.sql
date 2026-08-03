-- Подключаемый провайдер ИИ + полнотекстовый поиск по базе знаний.
--
-- Провайдер повторяет модель payment_merchant: ключ лежит зашифрованным, тумблер
-- в админке включает его без рестарта, лимиты расхода — в settings.
--
-- Поиск по базе знаний — обычный FTS Postgres, без pgvector: база поддержки это
-- десятки документов, а расширение + модель эмбеддингов = внешняя зависимость
-- ради того, что решается одним индексом. Выражение to_tsvector('russian', ...)
-- immutable (конфигурация задана литералом), поэтому индексируется напрямую.
CREATE TABLE IF NOT EXISTS "ai_provider" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
  "provider" text NOT NULL,
  "alias" text NOT NULL,
  "is_enabled" boolean DEFAULT false NOT NULL,
  "model" text NOT NULL,
  "credentials" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_check_at" timestamp with time zone,
  "last_check_ok" boolean,
  "last_check_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_org_alias_uq" ON "ai_provider" ("org_id","alias");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kb_document_fts_idx" ON "kb_document" USING gin (to_tsvector('russian', "title" || ' ' || "body"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_suggestion_conversation_idx" ON "ai_suggestion" ("org_id","conversation_id","created_at");

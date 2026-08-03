-- Роли операторов админки и вход по Telegram.
--
-- Роли сведены к трём с линейной вложенностью: superadmin > admin > support.
-- Старые значения маппятся так, чтобы никто не потерял доступ и никто его не получил
-- сверх прежнего: owner был полным доступом → superadmin, admin и operator сегодня
-- равны по правам → admin. support вводится только новыми учётками.
--
-- email становится nullable: у пришедшего через Telegram оператора почты нет.
-- Уникальность (org_id, email) сохраняется — NULL'ы Postgres считает различными.
ALTER TABLE "user" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "telegram_id" bigint;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "telegram_username" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "display_name" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "approved_by_user_id" uuid;--> statement-breakpoint

UPDATE "user" SET "role" = 'superadmin' WHERE "role" = 'owner';--> statement-breakpoint
UPDATE "user" SET "role" = 'admin' WHERE "role" = 'operator';--> statement-breakpoint

-- Дефолты — минимальные права и отсутствие доступа: строка, вставленная без явных
-- role/status, не должна давать полномочий.
ALTER TABLE "user" ALTER COLUMN "role" SET DEFAULT 'support';--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint

-- Домен ролей и статусов держит БД, а не только TypeScript: постороннее значение
-- (ручной UPDATE, старый сид) не даёт ни одной роли и молча убивает учётку — все
-- экраны отвечают 403 без внятной причины. Пусть такая запись просто не проходит.
ALTER TABLE "user" ADD CONSTRAINT "user_role_check" CHECK ("role" IN ('support','admin','superadmin'));--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_status_check" CHECK ("status" IN ('pending','active','disabled'));--> statement-breakpoint

ALTER TABLE "user" ADD CONSTRAINT "user_approved_by_user_id_fkey"
  FOREIGN KEY ("approved_by_user_id") REFERENCES "user"("id");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "user_org_telegram_uq" ON "user" ("org_id","telegram_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "telegram_auth_setting" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid DEFAULT '00000000-0000-0000-0000-000000000001' NOT NULL,
  "is_enabled" boolean DEFAULT false NOT NULL,
  "bot_username" text DEFAULT '' NOT NULL,
  "bot_token" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_auth_setting_org_uq" ON "telegram_auth_setting" ("org_id");

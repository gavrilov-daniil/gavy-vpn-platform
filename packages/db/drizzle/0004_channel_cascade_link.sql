-- Канал подписки связывается со своим каскадом.
-- Без этой колонки subgen не мог отфильтровать каскадные каналы по cascade_link.status:
-- канал попадал в подписку, когда одно плечо ещё не применило конфиг, и трафик клиента уходил в никуда.
-- Колонка nullable: у direct-каналов каскада нет.
ALTER TABLE "channel" ADD COLUMN IF NOT EXISTS "cascade_link_id" uuid;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "channel" ADD CONSTRAINT "channel_cascade_link_id_cascade_link_id_fk"
    FOREIGN KEY ("cascade_link_id") REFERENCES "public"."cascade_link"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "channel_cascade_link_idx" ON "channel" USING btree ("cascade_link_id");

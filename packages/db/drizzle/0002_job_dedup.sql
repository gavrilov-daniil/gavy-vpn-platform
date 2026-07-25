-- Дедуп служебных действий джоб (алерты операторам и т.п.).
-- Отдельно от message_log: там subscriber_id NOT NULL, а у алерта оператору подписчика нет.
-- Раньше дедуп жил только в Redis: без Redis алерт повторялся на каждом тике планировщика.
CREATE TABLE IF NOT EXISTS job_dedup (
  key         text PRIMARY KEY,
  org_id      uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS job_dedup_kind_idx ON job_dedup (org_id, kind, created_at);

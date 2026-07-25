-- Учётки операторов вместо одного общего ADMIN_TOKEN.
--
-- Общий секрет нельзя отозвать у одного человека, не сломав вход всем; по логу
-- не видно, кто именно правил мерчанта или запускал рассылку; ротация означает
-- одновременную смену у всех. Для одного оператора это терпимо, для команды нет.
--
-- Таблица user уже существует (id, org_id, email, password_hash, role, status).
-- Здесь добавляется только хранилище сессий: пароль в браузере не держим,
-- держим случайный токен сессии с истечением.
CREATE TABLE IF NOT EXISTS operator_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001',
  user_id      uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  -- в БД только хеш: утечка дампа не должна давать готовые сессии
  token_hash   text NOT NULL,
  user_agent   text,
  ip           text,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS operator_session_token_uq ON operator_session (token_hash);
CREATE INDEX IF NOT EXISTS operator_session_user_idx ON operator_session (user_id, expires_at);

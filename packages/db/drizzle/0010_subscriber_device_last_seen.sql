-- Индекс под энфорсмент hwid device-limit.
--
-- Проверка лимита идёт на КАЖДОЙ выдаче подписки (самый горячий публичный путь):
-- «устройства этой подписки, виденные за последние N дней». Существующий unique
-- (subscription_id, hwid) для такого запроса даёт только префикс по подписке,
-- last_seen_at приходится фильтровать поверх.
--
-- Тем же индексом закрывается сортировка списка устройств в карточке подписчика.
CREATE INDEX IF NOT EXISTS "subscriber_device_sub_last_seen_idx"
  ON "subscriber_device" ("subscription_id", "last_seen_at" DESC);

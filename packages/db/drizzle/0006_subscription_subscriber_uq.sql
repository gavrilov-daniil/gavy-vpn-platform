-- Одна подписка на подписчика.
--
-- Инвариант держался только кодом (advisory-lock в ensureSubscription), а параллельные
-- /start в двух инстансах core создали бы две подписки — то есть два разных URL
-- у одного клиента, и один из них не обновлялся бы после оплаты.
-- Место такому инварианту — в БД: блокировка в коде не переживает второй процесс.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_org_subscriber_uq
  ON subscription (org_id, subscriber_id);

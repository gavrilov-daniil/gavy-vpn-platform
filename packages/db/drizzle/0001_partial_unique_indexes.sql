-- Partial unique индексы: идемпотентность там, где полный UNIQUE не подходит.
-- Drizzle их декларативно не выражает — держим отдельной ручной миграцией.
-- Механика проверена продом gavy-vpn: код ловит нарушение уникальности как ШТАТНУЮ ветку
-- («уже обработано») и молча выходит, а не как ошибку. Гонки решаются БД, а не блокировками.

-- 1) Первый оплаченный платёж подписчика — ровно один.
--    Гонка двух параллельных вебхуков на «первую покупку» решается здесь.
CREATE UNIQUE INDEX IF NOT EXISTS payment_first_paid_uq
  ON payment (subscriber_id)
  WHERE is_first_paid = true;

-- 2) Регистрация по ссылке кампании засчитывается один раз на пару (подписчик, ссылка).
--    Повторный приход по той же ссылке → событие с meta.revisit, счётчик не растёт.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_event_registration_uq
  ON campaign_event (subscriber_id, campaign_link_id)
  WHERE type = 'registration' AND subscriber_id IS NOT NULL;

-- 3) Платёжное событие атрибуции — одно на платёж.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_event_payment_uq
  ON campaign_event (payment_id)
  WHERE type = 'payment' AND payment_id IS NOT NULL;

-- 4) У контакта одновременно только один незакрытый диалог поддержки.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_open_uq
  ON conversation (contact_id)
  WHERE status IN ('open', 'pending');

-- 5) Триал выдаётся один раз на подписчика.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_trial_uq
  ON subscription_activation (subscription_id)
  WHERE action = 'created';

-- Снимок источника трафика в платёж — триггером, а не правкой каждого места создания платежа.
-- В проде это избавило от дублирования в 5 flow-сервисах.
CREATE OR REPLACE FUNCTION fn_payment_set_campaign_link() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.campaign_link_id IS NULL THEN
    SELECT campaign_link_id INTO NEW.campaign_link_id
      FROM subscriber WHERE id = NEW.subscriber_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_payment_set_campaign_link ON payment;
CREATE TRIGGER trg_payment_set_campaign_link
  BEFORE INSERT ON payment
  FOR EACH ROW EXECUTE FUNCTION fn_payment_set_campaign_link();

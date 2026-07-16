# Roadmap

Все 4 контура — в roadmap, релиз фазами. Порядок: сначала де-риск ядра выдачи и takeover ноды, потом MVP на реальных мигрированных юзерах, потом автоматизация инфры, потом поддержка и CRM.

Контуры: **A** Инфра-ядро · **B** Пользователи и деньги · **C** Поддержка · **D** CRM/воронка.

---

## M0 — Скелет + два go/no-go спайка

Цель: доказать, что ядро воспроизводимо, ДО написания фич. Ревьюер: «любой спайк красный — пересматриваем архитектуру до, а не после монорепо».

- [x] Монорепо: `apps/core`, `apps/node-agent`, `apps/admin`, `packages/db`, `packages/xray-config`.
- [x] docker-compose (postgres + redis), `.env.example`, tooling.
- [x] Каноническая схема БД (Drizzle) — контуры A/B ядро.
- [x] `packages/xray-config`: `assembleBase` + `projectVariants` + `validateConfig` (инварианты loopback/split/observatory/VARIANTS).
- [x] `apps/core`: выдача подписки `/auto/:shortUuid` + `/api/sub/:id` с корректными заголовками (эталонный end-to-end флоу).
- [x] `apps/node-agent`: скелет reconcile-loop (pull → hash-compare → apply), brownfield keypair.
- [ ] **Спайк 1:** golden-config byte-diff зелёный на реальном мигрированном юзере vs Remnawave `/api/sub/<id>/json`.
- [ ] **Спайк 2:** node-agent забирает 1 существующую exit-ноду без смены `pbk`.

**DoD M0:** оба спайка зелёные. Красный → правим архитектуру, не идём в M1.

**Решение до M0-финиша (заказчик):** где физически крутить core. Beget-панель 1CPU/1GB не потянет новый стек + работающий Remnawave. Нужен новый бокс, желательно вне РФ-хостинга («Антифрод 2.0» + RS256-ключ подписи конфигов = single point).

---

## M1 — MVP: выдача мигрированному + приём Telegram Stars (контуры A + B-core)

Первый работающий релиз на реальных юзерах.

- Verbatim-импорт N юзеров (short_uuid + vless_uuid + HWID) в `subscription`.
- Один control-plane над существующими нодами (takeover нода-за-нодой, ключи импортированы).
- Выдача подписки на том же URL, база byte-diff-чиста, VARIANTS (Авто + DE/FI/PL/US), loopback-failover, geo-free split, split-DNS.
- **Один** платёжный провайдер — **Telegram Stars** (макс. объём, нативно, без карточного риска) → ledger topup → активация/продление → reconcile. Полные барьеры идемпотентности.
- Дешёвый анти-абьюз конфигом: `bittorrent→block`, `egress:25→block`.
- Создание ноды / скрещивание каскада — руками через админ-формы/SQL (без красивого UI).

**DoD M1:** реальный мигрированный юзер на новой панели платит через Stars, получает продление доступа; failover работает на устройстве; повторный вебхук не даёт лишних дней.

**Отложено из MVP:** крипта, RAG/AI-поддержка, CRM/кампании, юнит-экономика сверх reminder'а, RLS-машинерия, gRPC bidi, autopay/dunning, анти-абьюз-движок (только дешёвые Xray-правила).

---

## M2 — Инфра-автоматизация + трафик/анти-абьюз (контур A полный + B инфра)

- node-agent bootstrap голого VPS (cloud-init/`curl|sh`), born-on-node keypair.
- Оркестрация каскадов из UI (декларативно «скрестить relay X с exit Y», двухфазная активация).
- Сбор статистики трафика: per-subscriber / per-node / per-inbound, online/last-seen, разбивка по устройствам/платформам (из HWID-заголовков). Дашборды.
- Анти-абьюз-движок: детект аномалий по stats (объём, up/down→1, ip_fanout), throttle (`tc`) / suspend / torrent-ban через conntrack.
- Учёт инфра-расходов: `infra_resource(next_renewal_at)` + cron-напоминания о продлении серверов/доменов. Маржа доход vs расход по нодам.
- Крипта (CryptoBot/Cryptomus/CryptoCloud), промокоды, рефералка.

---

## M3 — Поддержка (контур C)

- ТГ-бот приёма сообщений → тикет; ответ оператора → обратно в ТГ (webhook, fast-ack, дедуп `telegram_update_id`).
- Модель `conversation`/`message`/assignment, realtime оператору (SSE).
- Подключаемый ИИ: RAG по базе знаний (FAQ, инструкции по Happ) — старт с auto-suggest оператору, эскалация деньги→человек.

MVP-поддержка (уже в M1, минимально): бот форвардит сообщение в админ-чат, без conversations/AI.

---

## M4 — CRM / воронка / рассылки (контур D)

- Событийная модель воронки (`event` append-only; `config_fetched` эмитит выдача подписки = реальная активация), attribution через ТГ deep-link `start=utm`.
- Метрики: trial→paid, churn по когортам, LTV, MRR.
- Движок кампаний касаний (drip/lifecycle): сегменты, триггеры (не оплатил trial → напоминание; кончается подписка → продли; отток → возврат-акция).
- Broadcast через ТГ-бота: троттлинг (~25/s), идемпотентность (`run_id` в ключе), отписки, батчинг через очередь.

---

## Топ-риски и как закрываем

| Риск | Закрытие |
|---|---|
| Перегенерация Reality-ключей рвёт клиентов | brownfield-импорт keypair, спайк 2 |
| Смена URL подписки — отвал клиентов | тот же host/path/заголовки, инвариант в `migration.md` |
| Генератор конфигов дрейфует → молчаливый отвал failover | golden byte-diff (спайк 1) + инвариант-валидатор в `xray-config` |
| Две панели дерутся за ноду | cutover нода-за-нодой, host в Remnawave гасится |
| Нет канонической схемы → rework | одна схема в `packages/db`, эта фаза |
| Утечка payload (plain-text pbk + uuid) | защита эндпоинта несущая (UA/rate-limit/short_uuid/HWID/ip_count→revoke), дешёвый revoke |
| core на РФ-хостинге изымут | core вне РФ (решение M0), RS256-ключ вне РФ |
| Двойная активация платежа | `UNIQUE(provider, provider_payment_id)` + `subscription_activation.payment_id UNIQUE` |
| Commit→enqueue gap (оплатил, ноды не узнали) | safety-net cron: реконсиль подписок где `desired_hash != last_acked_hash` |
| Scope creep (C/D раньше времени) | C/D после релиза A+B на реальных юзерах |

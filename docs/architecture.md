# Архитектура gavy-vpn-platform

Своя платформа управления VPN-сетью — постепенная замена Remnawave. Отдельный проект, тестовый контур, миграция пользователей со старой панели. Модель данных SaaS-ready (`org_id` с первого дня), деплой для своей сети (org = 1).

Ядро существующей сети (skippnet: control-plane декларативен в клиентском Xray-конфиге, панель = source of truth, парк нод, sub-генератор) воспроизводится **1:1** — иначе мигрированные с Remnawave клиенты отвалятся. Источник истины по сети: `~/Projects/vpn-network-2/docs/`.

Документ описывает **фактическое** устройство кода. Всё, что спроектировано, но не написано, помечено явно и вынесено в `security.md` → «Незакрытые пункты».

## Карта документации

| Документ | О чём |
|---|---|
| `architecture.md` (этот) | сервисы, стек, модель данных, генератор конфигов, control-plane, ADR |
| `subscription.md` | выдача подписки: профили/каналы, инварианты генератора, заголовки, защита эндпоинта |
| `payments.md` | мерчанты в БД, 5 провайдеров, единый платёжный flow, ledger |
| `workers.md` | воркеры, cron, leader-lock, degraded-режим без Redis, алерты |
| `support-crm.md` | контуры C (поддержка) и D (CRM, рассылки, касания) |
| `security.md` | гварды, токены, шифрование кредов, модель угроз, незакрытые пункты |
| `migration.md` | P0-инварианты миграции с Remnawave, cutover, результаты golden-diff |
| `roadmap.md` | что сделано, что в работе, что осталось |
| `apps/bot/README.md` | боты: транспорт, экраны, контракт с core |
| `apps/node-agent/README.md` | агент: reconcile-loop, конфиг, Reality-ключи |

## Сервисы (4 деплой-артефакта, не микросервисы)

| Сервис | Стек | Роль | Публичный |
|---|---|---|---|
| **core** (`api` \| `worker`) | NestJS 10 / Node 22 / TS | Модульный монолит: вся доменная логика, сборка клиентских конфигов и конфигов нод, выдача подписки, приём платёжных вебхуков, API для агента, cron-эмиттер и консьюмер очереди. Владеет БД. | api за прокси; выдача подписки — да |
| **bot** | NestJS 10 + grammy | Два бота в одном процессе: клиентский (продажи, самообслуживание, поддержка) и алертовый (уведомления операторам). Своей БД нет, состояние — в core. | webhook `POST /tg` — да |
| **node-agent** | Go, только stdlib, `CGO_ENABLED=0` | На ноде: держит Xray сходящимся с desired-state (pull по HTTPS), буферизует stats, heartbeat. | нет (dial-out) |
| **admin** | React 18 + Vite 6, SPA | UI операторов: 7 экранов. Вход — общий `ADMIN_TOKEN`. | за прокси |

Один Postgres, один транзакционный контур. `core` — один пакет, два режима запуска (`INSTANCE_TYPE=api|worker`): `worker` поднимает тот же DI-контекст без HTTP и требует Redis (без него пишет ошибку и завершается).

Порты по умолчанию: core `3100`, bot `3300`, admin dev-server `3200`, Postgres `5442`, Redis `6392` (`docker-compose.yml`, `vite.config.ts`).

### Осознанные упрощения относительно первичного дизайна

- **Выдача подписки живёт в `core` (Node), отдельного Go-edge в MVP нет.** Go-edge оправдан почти только JA3-фильтром, а JA3 ненадёжен (спуфится, TLS-fp Happ плывёт между версиями → ложные локауты). Фактическая защита эндпоинта сегодня — UA-гейт `happ` + неугадываемый `short_uuid` (12 случайных байт). Rate-limit, HWID-энфорсмент и авто-revoke по `ip_count` **не реализованы** — детали и последствия в `security.md`.
- **admin — статический SPA, не Next.js SSR.** Для горстки операторов SSR — избыточный вес.
- **node-agent v1 — тонкий:** запись полного конфига в файл + `systemctl restart` Xray. Без live-`AlterInbound`-дельты. Статистику агент снимает через gRPC `StatsService.QueryStats(reset:true)` собственным минимальным клиентом на stdlib (нативный h2c из Go 1.24) — `go.mod` остался без единой зависимости, бинарник вырос на 20 КБ. Против живого Xray путь не проверялся.
- **Go — только в node-agent.** Второй язык оправдан единственным жёстким требованием «статический бинарь без Docker на ноде».

## Стек

| Слой | Выбор | Обоснование |
|---|---|---|
| Backend | NestJS 10.4 / Node 22 / TS (ESM) | стек Node у заказчика, паритет с Remnawave (NestJS) упрощает миграцию |
| ORM | **Drizzle 0.36** | SQL-first, явный, без «магии» скрытых запросов; нативный partial-unique / upsert |
| БД | Postgres 16 | source of truth, JSONB для конфигов, partial-unique для идемпотентности |
| Очереди | Redis 7 + BullMQ 5 | одна очередь `core-jobs`, cron-расписание через `upsertJobScheduler` |
| Admin | React 18 + Vite 6 | React заказчик знает, лёгкий SPA |
| Bot | grammy | webhook или long polling по наличию `BOT_WEBHOOK_URL` |
| node-agent | Go (`CGO_ENABLED=0`), stdlib | статический бинарь, systemd + hardening |
| Транзакции | явный проброс `tx` | НЕ AsyncLocalStorage/CLS — это скрытая зависимость («магия») |

**NATS/шину не вводим.** Postgres + Redis(BullMQ) закрывают очереди/дедуп. Внутри `core` — in-process; async — BullMQ.

**Redis — не обязателен для `api`.** Без `REDIS_URL` core поднимается в degraded-режиме: очереди и расписания нет, джобы гоняются вручную из админки (`workers.md`).

**Синглтон-scheduler не делаем** (боль Remnawave — их `scheduler`/`processor` не размножить). Cron-эмиттер выбирается через Postgres advisory-lock (`pg_try_advisory_lock`) и только регистрирует расписание; консьюмеры масштабируются горизонтально.

## Модель данных

Каноническая схема — `packages/db/src/schema/*.ts`, **62 таблицы**, миграции в `packages/db/drizzle/`. Ключевые принципы:

- **`org_id` почти на каждой таблице** с дефолтом. **RLS/`SET LOCAL`-машинерии нет и не планируется до первого реального org #2** — это преждевременная абстракция и «двойная цена» (явный `WHERE org_id = …` всё равно нужен). «SaaS-ready» = колонка, а не машинерия. Значение фильтра берётся из `DEFAULT_ORG_ID`.
  Оговорки, которые всплывут при появлении второго тенанта: колонки нет у таблиц, адресуемых по FK (`node_desired_state`, `node_reported_state`, `node_identity`, `online_state`, `routing_domain_entry`, `squad_inbound`, `subscription_squad`), а часть точечных запросов идёт по первичному ключу без фильтра по org (например, обновление результата health-check мерчанта). При org = 1 это безопасно, при org = 2 требует ревизии.
- **`user` (админ панели) ≠ `subscriber` (конечный VPN-юзер)** — жёсткое разделение.
- **`server` (физический хост) ≠ `node` (логический Xray на хосте).**
- **Ledger-first деньги:** `ledger_entry` append-only, баланс = `SUM(amount_kopeks)`; поля `balance` не существует.
- **Ledger-first трафик:** `traffic_sample` append-only с дедупом по окну; `subscription.used_traffic_bytes` — кэш-роллап, истина в сэмплах.
- **Идемпотентность на unique-индексе БД**, не SELECT+INSERT. Нарушение уникальности ловится как штатная ветка «уже обработано».

Секреты Reality-**privatekey** в БД не хранятся никогда — только на ноде. В БД — `reality_public_key`, `short_ids`, `sni`, `fingerprint`, `flow`.

**Отличие от первоначального плана:** платёжные ключи **лежат в БД** (`payment_merchant.credentials`), а не в env — иначе не получить несколько аккаунтов одного провайдера и переключение без рестарта. Защита — шифрование AES-256-GCM ключом `SECRETS_MASTER_KEY` из env (см. `payments.md`, `security.md`).

Маппинг Remnawave → новые таблицы: `migration.md`.

## Генератор конфигов (`packages/xray-config`) — самый fidelity-critical компонент

Старый subgen тянул базовый Remnawave `/api/sub/<id>/json` и рефильтровал. У нас Remnawave не будет — **базу собираем сами** из модели.

| Функция | Что делает |
|---|---|
| `buildProfileConfig` | один полный Xray-конфиг для профиля: outbounds каналов, балансеры, observatory, loopback, split-routing, split-DNS |
| `assembleBase` | конфиг профиля «Авто» (все direct в tier1, все cascade в tier2). Против него идёт golden byte-diff (спайк 1) |
| `projectVariants` | VARIANTS-проекция: массив полных конфигов по профилям (формат мульти-профильной подписки Happ) |
| `validateConfig` | инвариант-валидатор перед публикацией. Не прошло — конфиг не публикуется, клиенту уходит 503 |
| `buildNodeConfig` | конфиг **ноды** по роли (exit/relay/front) + server-forward каскады; `configHash` детерминирован |

Инварианты клиентского конфига (нарушение = молчаливый отвал клиента, ловит `validateConfig`):

- Loopback-цепочка целостна: `tier1 fallbackTag=lo-out-1 → dokodemo lo-in-1 (listen 127.0.0.1, port 0, network tcp,udp) → routing inboundTag:[lo-in-1]→tier2`. **Последний tier — без `fallbackTag`** (иначе вечная петля). Реинжект обязан стоять до catch-all.
- Локальный freedom-outbound зовётся ровно `freedom` (селектор балансера префиксный — `direct-*` зацепит рунет).
- Никаких `geoip:`/`geosite:` (в Happ нет geo-баз → валит XrayCore).
- **Порядок split-routing: приватные CIDR → `freedom`, bittorrent → `block`, udp:443 → `block`, РФ-домены/зоны/CIDR → `freedom`, catch-all → балансер (или единственный outbound).** Порядок сверен с боевой панелью в спайке golden-diff; приватные сети первыми, чтобы локалка не зависела ни от блокировок, ни от РФ-списков. Правил после catch-all быть не должно.
- Стратегии балансеров: тир с `fallbackTag` (первичный) обязан быть `leastPing`; резервный тир каскадов в бою — `random`. Требовать `leastPing` от всех нельзя — такая проверка отвергала боевой конфиг.
- Селекторы разных балансеров не должны префиксно пересекаться — иначе тиры схлопываются и failover исчезает молча.
- Top-level `observatory` (не `burstObservatory` — баг Xray #5897), `subjectSelector` ⊇ union всех селекторов, `probeUrl` по https. **Профиль без балансеров (единственный канал) идёт и без observatory** — измерять нечего.
- `sniffing.enabled + routeOnly:true` на пользовательских inbound.
- `dns.queryStrategy = UseIPv4`, `routing.domainStrategy = AsIs`.
- `flow`: на `tcp`+`reality` обязателен `xtls-rprx-vision` (в т.ч. на **обоих** плечах каскада), на grpc/xhttp — обязан быть пустым. `sockopt.dialerProxy` должен ссылаться на существующий outbound.
- Каскад виден в подписке только при `cascade_link.status='active'` (обе ноды применили конфиг) — защита от полу-каскада.

**Спайк 1 (go/no-go):** сгенерённая база для реального мигрированного юзера семантически byte-diff-чиста против текущего Remnawave-вывода `/api/sub/<id>/json`. Первый прогон уже сделан, расхождения устранены — см. `migration.md`.

## Control-plane и node-agent

- Агент **dial-out** (pull), не панель push. РФ-relay за NAT/фаерволом, IP — движущаяся мишень. Ноде нужен только исходящий 443. Панель легла → агент крутит последний конфиг и копит stats.
- Desired-state — полная декларация (`configHash = sha256(canonical_json)` + список юзеров). Агент сходится: `configHash != applied` → записать файл + `systemctl restart` Xray; совпало — no-op.
- Три эндпоинта под `/internal/agent/nodes/:nodeId/`: `GET desired-state`, `POST report`, `POST stats`.
- **Аутентификация агента сегодня — общий заголовок `x-agent-token`** (`AgentController.assertToken`). Пустой `AGENT_TOKEN` в core = 401 на любой запрос агента (fail-closed). `ServiceTokenGuard` пропускает `/internal/agent/*` мимо себя: у агента свой секрет, общий сервисный токен ему не дают.
- **mTLS — опционален и только на стороне агента.** `client_cert_path` + `client_key_path` включают клиентский сертификат и поднимают минимум до TLS 1.3; пустые — обычный HTTPS (TLS 1.2+). Оба пути задаются только вместе. **Control-plane клиентские сертификаты не выпускает и не проверяет** — эту часть предстоит написать.
- **Подпись desired-state (RS256) — механизм есть в агенте, control-plane её не ставит.** Агент принимает голый JSON только если `cp_public_key_path` пуст; если ключ задан, а подписи нет — ошибка (иначе подпись снималась бы удалением поля). Конверт без ключа — тоже ошибка. Ошибка не роняет агента: нода продолжает крутить последний применённый конфиг.
- **Bootstrap-энроллмента нет.** Эндпоинта регистрации ноды в `core` не существует, метода `Register` в агенте нет. `node_id`, `agent_token`, `agent_epoch` кладутся в конфиг агента руками при раскатке. В БД под будущий энроллмент лежит таблица `node_identity` (`bootstrap_token_hash`, `bootstrap_consumed_at`, `cert_fingerprint`, `agent_pubkey`) — **кода, который бы её читал или писал, нет ни строки**.
- **Reality privatekey генерится на ноде, наружу не уходит.** В конфиге от CP приходит плейсхолдер `__REALITY_PRIVATE_KEY__`, агент подставляет содержимое `reality_private_key_path` при записи файла. Для миграции — `reality_keypair_mode=import`: отсутствие файла ключа = жёсткая ошибка, а не тихая генерация нового `pbk`.

**Спайк 2 (go/no-go):** node-agent забирает одну существующую exit-ноду без смены `pbk` (импорт ключа) — уже розданные клиентские конфиги продолжают коннектиться.

## Идемпотентность — карта фактических ключей

Очередь в системе **одна** — BullMQ `core-jobs` (`workers.md`). Разделения на очереди по доменам нет: у джоб разное расписание, но общий консьюмер. Дедуп живёт не в очереди, а на индексах БД:

| Операция | Барьер | Где |
|---|---|---|
| Приём батча статистики | `traffic_report_uq (node_id, report_id)`; повтор → `accepted:false`, агент дропает батч | `StatsService.ingest` |
| Отдельная дельта трафика | `traffic_sample_uq (node_id, subject_type, subject_key, window_start)` | там же |
| Платёжный вебхук | `payment_provider_uq (org_id, provider, provider_payment_id)` + атомарный CAS статуса `pending\|processing\|expired\|failed → paid` | `PaymentService` |
| Начисление в ledger | `ledger_idempotency_uq (idempotency_key)`, ключи вида `topup:<paymentId>` | `LedgerService` |
| Активация подписки платежом | `sub_activation_payment_uq (payment_id)` | `LedgerService.applyPlan` |
| Первая оплата подписчика | partial unique `payment_first_paid_uq (subscriber_id) WHERE is_first_paid` | миграция 0001 |
| Создание счёта из бота | заголовок `x-client-request-id` → `IdempotencyService` (**память процесса**, не Redis) | `PaymentsController.create` |
| Реф-награда | CAS статуса + `ledger_idempotency_uq` | `ReferralRewardPromoteJob` |
| Регистрация по ссылке кампании | partial unique `campaign_event_registration_uq` + first-touch `UPDATE … WHERE campaign_link_id IS NULL` | `AttributionService` |
| Атрибуция платежа | partial unique `campaign_event_payment_uq (payment_id)` | там же |
| Входящий TG-update (поддержка) | `message_tg_update_uq (telegram_update_id)` | `SupportService` |
| Входящий TG-update (аналитика) | `bot_event_update_uq (update_id)` | `EventsService` |
| Один незакрытый диалог у контакта | partial unique `conversation_open_uq (contact_id) WHERE status IN (open,pending)` | миграция 0001 |
| Рассылка / касание / уведомление | `message_log_dedup_uq (dedup_key)`, claim пишется **до** отправки | `DispatchService` |
| Алерт оператору | `job_dedup` (PK по ключу, суточный bucket); при неудачной отправке ключ отпускается | `AlertService` |
| Анти-абьюз действие | `abuse_action_idempotency_uq`, ключ `kind:subscription:дата` | `AbuseService` |
| Одна подписка на подписчика | `subscription_org_subscriber_uq (org_id, subscriber_id)` (миграция 0006) | `SubscribersService` |
| Desired-state ноды | `config_hash`: rebuild не поднимает версию, если конфиг не изменился | `NodeStateService.rebuild` |

Снимок источника трафика в платёж проставляет триггер `trg_payment_set_campaign_link` — один раз в БД вместо дублирования в каждом месте создания платежа.

## ADR (кратко)

- **ADR-1.** Модульный монолит `core` + тонкий Go node-agent, не микросервисы. Режем по швам `org_id`/очередей, когда упрёмся (парк ×10).
- **ADR-2.** Control-plane = desired-state в Postgres + reconcile-loop агента (dial-out, сходимость по hash), не push.
- **ADR-3.** Tenancy: `org_id` везде, явный фильтр. RLS — позже, при первом реальном org #2. Сейчас RLS нет нигде.
- **ADR-4.** Ledger-first деньги + protocol-independent учёт трафика (append-only дельты, дедуп по `report_id`).
- **ADR-5.** Очереди BullMQ/Redis, без NATS; в MVP одна очередь `core-jobs`. HTTPS-pull node↔core в v1 (gRPC — позже).
- **ADR-6.** Выдача подписки в `core` (Node), не отдельный Go-edge. JA3 не используется вовсе. Пересмотр — если понадобится TLS-fp-фильтр.
- **ADR-7.** Мерчанты — строки в БД с шифрованными кредами, не env. Цена — мастер-ключ становится критическим секретом деплоя; выгода — несколько аккаунтов одного провайдера и переключение без рестарта.
- **ADR-8.** Аутентификация агента в v1 — общий bearer-токен в заголовке. mTLS и подпись desired-state оставлены опциональными точками расширения в агенте; серверная часть не написана осознанно (сначала спайк 2, потом энроллмент).

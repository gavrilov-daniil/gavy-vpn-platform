# Архитектура gavy-vpn-platform

Своя платформа управления VPN-сетью — постепенная замена Remnawave. Отдельный проект, тестовый контур, миграция пользователей со старой панели. Модель данных SaaS-ready (`org_id` с первого дня), деплой для своей сети (org = 1).

Ядро существующей сети (skippnet: control-plane декларативен в клиентском Xray-конфиге, панель = source of truth, парк нод, sub-генератор) воспроизводится **1:1** — иначе мигрированные с Remnawave клиенты отвалятся. Источник истины по сети: `~/Projects/vpn-network-2/docs/`.

## Сервисы (3 деплой-артефакта в MVP, не микросервисы)

| Сервис | Стек | Роль | Публичный |
|---|---|---|---|
| **core** (`api` \| `worker`) | NestJS 11 / Node 22 / TS | Модульный монолит: вся доменная логика, сборка клиентских конфигов, выдача подписки, продюсер/консьюмер очередей, приём платёжных вебхуков. Владеет БД. | api за прокси; выдача подписки — да |
| **node-agent** | Go, статический бинарь | На ноде: держит Xray, применяет desired-state (pull по HTTPS), снимает stats, heartbeat, bootstrap. | нет (dial-out) |
| **admin** | React SPA (Vite) | UI операторов: ноды, подписчики, биллинг. | за прокси, auth |

Один Postgres, один транзакционный контур. `core` — один пакет, два режима запуска (`INSTANCE_TYPE=api|worker`).

### Осознанные упрощения относительно первичного дизайна (по итогам adversarial-ревью)

- **Выдача подписки живёт в `core` (Node), отдельного Go-edge в MVP нет.** Go-edge оправдан почти только JA3-фильтром, а JA3 ненадёжен (спуфится, TLS-fp Happ плывёт между версиями → ложные локауты). Несущая защита эндпоинта: UA Happ-only + rate-limit + неугадываемый `short_uuid` + HWID device-limit + аномалия `ip_count` → авто-revoke. JA3 — best-effort, отдельный Go-edge выносим позже, если понадобится.
- **admin — статический SPA, не Next.js SSR.** Для горстки операторов SSR — избыточный вес.
- **node-agent v1 — тонкий:** конфиг-файл + `reload` Xray, pull полного desired-state по HTTPS с mTLS-клиент-сертом. Без live-`AlterInbound`-дельты и gRPC bidi-стрима (при низком churn рестарт Xray при смене юзеров приемлем). No-restart дельта и gRPC — оптимизация на потом.
- **Go — только в node-agent.** Второй язык оправдан единственным жёстким требованием «статический бинарь без Docker на ноде».

## Стек

| Слой | Выбор | Обоснование |
|---|---|---|
| Backend | NestJS 11 / Node 22 / TS | стек Node у заказчика, паритет с Remnawave (NestJS) упрощает миграцию, зрелый BullMQ |
| ORM | **Drizzle** | SQL-first, явный, без «магии» скрытых запросов; нативный partial-unique / upsert |
| БД | Postgres 16 | source of truth, JSONB для конфигов, partial-unique для идемпотентности |
| Очереди/кэш | Redis + BullMQ | очереди, дедуп вебхуков (TTL), rate-limit, кэш рендера подписки |
| Admin | React + Vite | React заказчик знает, лёгкий SPA |
| node-agent | Go (`CGO_ENABLED=0`) | статический бинарь, systemd + hardening |
| Транзакции | явный проброс `tx` | НЕ AsyncLocalStorage/CLS — это скрытая зависимость («магия») |

**NATS/шину не вводим.** Postgres + Redis(BullMQ) закрывают очереди/дедуп/кэш. Внутри `core` — in-process; async — BullMQ. Шина только когда появится реальный event fan-out между сервисами.

**Синглтон-scheduler не делаем** (боль Remnawave — их `scheduler`/`processor` не размножить). Cron-эмиттер выбирается через Postgres advisory-lock (leader-lock) и только кладёт идемпотентные time-bucketed джобы; консьюмеры масштабируются горизонтально.

## Модель данных

Каноническая схема — `packages/db/schema`. Ключевые принципы:

- **`org_id` на каждой таблице** с дефолтом. **Без RLS/`SET LOCAL`-машинерии** в MVP — это преждевременная абстракция и «двойная цена» (явный WHERE всё равно нужен). RLS вводим при первом реальном org #2. «SaaS-ready» = колонка, а не машинерия.
- **`user` (админ панели) ≠ `subscriber` (конечный VPN-юзер)** — жёсткое разделение.
- **`server` (физический хост) ≠ `node` (логический Xray на хосте).**
- **Ledger-first деньги:** `ledger_entry` append-only, баланс = `SUM(amount)`; строки не правятся.
- **Ledger-first трафик:** `traffic_sample` append-only с дедупом по окну; `used_traffic` = агрегат, счётчик не правится напрямую.
- **Идемпотентность на unique-индексе БД**, не SELECT+INSERT. Платёж — `UNIQUE(org, provider, provider_payment_id)`.

Секреты Reality-**privatekey** в БД не хранятся никогда — только на ноде. В БД — `public_key`, `short_ids`, `sni`, `fp`, `flow`. bot-token / payment-ключи / mTLS-signing — в env/vault (не в таблице `secret` с envelope — это для мульти-org).

Полная схема с группировкой по контурам и ключами идемпотентности: `packages/db/schema/*.ts`. Маппинг Remnawave → новые таблицы: см. `migration.md`.

## Генератор конфигов (`packages/xray-config`) — сердце и самый fidelity-critical компонент

Старый subgen тянул базовый Remnawave `/api/sub/<id>/json` и рефильтровал. У нас Remnawave не будет — **базу собираем сами** из модели. Два слоя, ровно повторяющие «база → фильтрация»:

1. **`assembleBase`** — per-subscriber базовый Xray-конфиг: все каналы (direct+cascade) как outbounds, балансер (`leastPing`), **top-level observatory** (не burst — обход бага Xray #5897), loopback-failover, geo-free split-routing, split-DNS `UseIPv4`. Per-user `vless_uuid` подставляется здесь.
2. **`projectVariants`** — VARIANTS-проекция в массив полных конфигов (формат Happ): профиль = `(remark, primary, fallback)`; канал `("d",tag)` direct | `("c",src,new)` cascade (клон exit-outbound с `sockopt.dialerProxy=front`, оба плеча `flow=xtls-rprx-vision`).
3. **`validateConfig`** — инвариант-валидатор перед публикацией (см. ниже). Не прошло — конфиг не публикуется.

Инварианты (нарушение = молчаливый отвал клиента, ловим валидатором):
- Loopback-цепочка целостна: `tier1 fallbackTag=lo-out-1 → dokodemo lo-in-1 (listen 127.0.0.1, port 0, network tcp,udp) → routing inboundTag:[lo-in-1]→tier2`. **Последний tier — без `fallbackTag`** (иначе вечная петля).
- Локальный freedom-outbound зовётся ровно `freedom` (селектор балансера префиксный — `direct-*` зацепит рунет).
- Никаких `geoip:`/`geosite:` (в Happ нет geo-баз → валит XrayCore).
- Split-routing порядок: `block udp:443+bittorrent` → private CIDR `freedom` → РФ-домены+зоны `freedom` → catch-all tier1.
- `sniffing routeOnly:true` на пользовательских inbound.
- Каскад виден в подписке только при `cascade_link.status=active` (обе ноды отчитались) — защита от полу-каскада.

**Спайк 1 (go/no-go):** сгенерённая база для реального мигрированного юзера семантически byte-diff-чиста против текущего Remnawave-вывода `/api/sub/<id>/json`. Любой diff — блокер.

## Control-plane и node-agent

- Агент **dial-out** (pull), не панель push. РФ-relay за NAT/фаерволом, IP — движущаяся мишень. Ноде нужен только исходящий 443. Панель легла → агент крутит последний конфиг и копит stats.
- Desired-state — полная декларация (`config_hash = sha256(canonical_json)` + список юзеров). Агент сходится: `config_hash != applied` → записать + reload/restart; юзеры — reconcile.
- Аутентификация: mTLS client-cert (энроллмент) + подпись desired-state (RS256), агент верифицирует по вшитому pubkey.
- **Reality privatekey генерится на ноде, наружу не уходит.** Для миграции — brownfield-импорт существующего ключа (см. `migration.md`), НЕ регенерация.

**Спайк 2 (go/no-go):** node-agent забирает одну существующую exit-ноду без смены `pbk` (импорт ключа) — уже розданные клиентские конфиги продолжают коннектиться.

## Очереди и идемпотентность (карта)

| Операция | Очередь | Ключ дедупа |
|---|---|---|
| Bootstrap ноды | provisioning | `bootstrap_token` (one-time, TTL) |
| Push конфига на ноду | node-config | `(node_id, config_version)` / hash |
| Ingest трафика | stats | `(node_id, report_id)` → insert ON CONFLICT DO NOTHING |
| Платёжный вебхук | payments | `UNIQUE(provider, provider_payment_id)` + ledger `idempotency_key` |
| Продление подписки | billing | `sub:<id>:<period_start>` |
| Напоминание о продлении | reminders | `(resource_id, threshold, date_bucket)` |
| Рассылка | campaigns | `(campaign_id, touchpoint_id, subscriber_id, run_id)` |
| Входящий TG-update | ingest | `UNIQUE(telegram_update_id)` |

## ADR (кратко)

- **ADR-1.** Модульный монолит `core` + тонкий Go node-agent, не микросервисы. Режем по швам `org_id`/очередей, когда упрёмся (парк ×10).
- **ADR-2.** Control-plane = desired-state в Postgres + reconcile-loop агента (dial-out, сходимость по hash), не push.
- **ADR-3.** Tenancy: `org_id` везде, явный фильтр. RLS — позже, при первом реальном org #2.
- **ADR-4.** Ledger-first деньги + protocol-independent учёт трафика (append-only дельты, дедуп по `report_id`).
- **ADR-5.** Очереди BullMQ/Redis, без NATS. HTTPS-pull node↔core в v1 (gRPC — позже).
- **ADR-6.** Выдача подписки в `core` (Node), не отдельный Go-edge. JA3 best-effort. Пересмотр — если JA3 станет несущим.

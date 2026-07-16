# Миграция с Remnawave — P0-инварианты и cutover

Мигрированные клиенты (Happ) держат сохранённый URL подписки и просто исполняют полученный конфиг. Любое расхождение = **молчаливый отвал** (Happ перестаёт обновляться / не коннектится, юзер не видит ошибки). Ниже — инварианты, нарушение любого из которых блокирует переключение.

## P0-инварианты (нарушение = релиз-блокер)

### 1. Reality-ключи — импорт, не регенерация
- node-agent при обычном bootstrap генерит новый Reality keypair → новый `pbk` → у ВСЕХ клиентов ноды рвётся конфиг.
- Для миграции — **brownfield-bootstrap**: импортировать существующий keypair из Remnawave DB / vault на ноду, агент его НЕ перегенерирует.
- Born-on-node (генерация на ноде) — только для абсолютно новых нод.
- Две модели безопасности не держатся одновременно: пока идёт миграция ноды — imporт; после — можно перейти на born-on-node через keypair-ротацию с наложением.

### 2. URL/host/path подписки — байт-в-байт
- Сохранить `panel.gavy.shop` (или CNAME на новый бокс) + **оба** пути: `/auto/<shortUuid>` (мульти-профиль) и legacy `/api/sub/<id>` (базовый Авто).
- Ответные заголовки — байт-в-байт: `subscription-userinfo: upload=…; download=…; total=…; expire=<unix>`, `profile-update-interval`, `profile-title`, `announce`, `support-url`.
- Не переносить на `sub.<domain>` — это отвал всех клиентов.

### 3. Идентичность — verbatim-импорт
- `short_uuid` + `vless_uuid` (+ `trojan_password`/`ss_password` где есть) + HWID-устройства — импортировать **как есть**.
- Инвариант: **на миграции никогда не регенерим** идентичность. `short_uuid` меняется только при явном revoke, не при импорте.
- HWID импортировать (иначе мигрированный юзер упрётся в device-limit заново) или первые N дней держать device-limit в soft-режиме.

### 4. Golden-config byte-diff (спайк 1, go/no-go)
- Перед cutover: сгенерить новую базу для реального мигрированного юзера и **семантически byte-diff'нуть** против текущего Remnawave `/api/sub/<id>/json`.
- Сверять: список outbounds/каналов, балансер (`leastPing`), top-level observatory (`subjectSelector` = union всех selector), loopback-цепочка (fallbackTag/lo-out/lo-in/routing, последний tier без fallback), split-routing (порядок правил, `freedom`-именование, отсутствие `geoip:`/`geosite:`), split-DNS `UseIPv4`, `sniffing routeOnly:true`.
- Любой diff — блокер до устранения.
- Инвариант из `panel.md`: в базовом конфиге ровно **1 видимый host-якорь**, остальные `isHidden` (все видимы → дубли; все скрыты → пустая подписка). Валидатор `xray-config` это проверяет.

## Cutover — нода за нодой (две панели не делят одну ноду)

Два control-plane на одной ноде невозможны — будут драться за список юзеров в одном Xray-inbound.

```
1. Новый бокс поднят, БД зеркалит Remnawave read-only (импорт subscribers/subscription/nodes/hosts/squads verbatim).
2. Golden-config byte-diff зелёный на реальном юзере (спайк 1).
3. Спайк 2 зелёный: node-agent забирает ОДНУ exit-ноду без смены pbk.
4. Для каждой ноды по очереди:
   a. node-agent устанавливается на ноду, импортирует существующий keypair, применяет desired-state.
   b. В Remnawave host этой ноды гасится (isDisabled) — Remnawave перестаёт ей управлять.
   c. Выдача подписки для этой ноды идёт уже с нового core.
   d. Проверка на реальном устройстве: коннект + failover direct→cascade.
5. Когда все ноды забраны — выдача полностью на новом core, Remnawave выключается.
```

Критерий готовности к полному переключению: все ноды под node-agent, golden-diff зелёный для выборки юзеров, failover подтверждён на устройстве, заголовки ответа идентичны.

## Маппинг Remnawave → новые таблицы

| Remnawave | Новая модель |
|---|---|
| user | `subscriber` + `subscription` |
| config profile | `config_profile` |
| inbound | `inbound` (+ Reality-идентичность на inbound) |
| node | `node` + `server` |
| host | `host` |
| internal squad | `squad` |
| HWID device | `subscriber_device` |
| XRAY_JSON template | `client_template` |
| VARIANTS (subgen.py, хардкод) | `profile` + `channel` + `profile_channel` (строки в БД) |

## Секреты миграции

Reality-privatekey существующих нод сейчас у Remnawave (панель их генерила и пушила — это та самая «дыра», которую чиним). Для импорта их берём из Remnawave DB / vault. После переноса на born-on-node приватники уходят с сети навсегда. IP, ключи, uuid — только в `~/personality/90-vault/projects/vpn-network-2.md`, в этот репозиторий не коммитить.

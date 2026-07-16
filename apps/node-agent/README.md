# node-agent

Демон на VPN-ноде. Держит локальный Xray сходящимся с желаемым состоянием
(desired state), которое отдаёт control-plane. Один статический бинарь
(`CGO_ENABLED=0`), только stdlib, без Docker. Работает под systemd с хардненингом.

## Что делает (v1, тонкий)

Цикл reconcile каждые `pull_interval`:

1. **pull** — агент сам дозванивается (dial-out) до control-plane по HTTPS с
   mTLS client-cert и запрашивает desired state. Панель на ноду **не ходит**:
   ноде нужен только исходящий 443, входящих портов управления нет.
2. **verify** — desired state приходит подписанным (RS256). Агент проверяет
   подпись по **вшитому** (запинненному) public key control-plane. Скомпро-
   метированный транспорт не даёт подделать конфиг без приватного ключа CP.
3. **apply (по hash, идемпотентно)** — если `config_hash != applied_hash`:
   записать весь Xray-конфиг в файл (атомарно) и `systemctl restart` Xray.
   Если hash совпал — no-op.
4. **report** — вернуть observed state: `applied_hash`, версии (агент/Xray),
   sys-stats. Плюс отгрузка накопленных stats (см. ниже).

Если control-plane офлайн — агент продолжает крутить последний применённый
конфиг и не падает; неудачный проход просто логируется.

Desired state (тело подписанного `payload`):

```json
{
  "version": 42,
  "config_hash": "<sha256 canonical json конфига>",
  "config": { "...весь Xray-конфиг ноды..." },
  "users": [ { "email": "a@b.c", "uuid": "...", "level": 0 } ]
}
```

## Режимы Reality keypair (важно для миграции)

Reality public key вшит в строку подключения каждого клиента как `pbk=`. Если он
меняется — рвутся **все** существующие клиенты. Поэтому `reality_keypair_mode`:

- `generate` — обычный bootstrap. Генерит x25519 keypair, **только если его ещё
  нет**. При повторном запуске переиспользует существующий (pbk не вращается).
- `import` — **миграция существующей ноды (P0)**. Читает приватник из
  `reality_private_key_path`. **Никогда не генерит**: отсутствие файла — жёсткая
  ошибка, а не молчаливая генерация нового ключа (иначе сменится pbk).

Приватник наружу не отдаётся. Агент репортит в CP только public key + shortIds.

## Установка (bootstrap)

```sh
curl -fsSL https://<control-plane>/install.sh | sh -s -- --token <ONE_TIME_TOKEN>
```

Скрипт кладёт бинарь в `/usr/local/bin/node-agent`, конфиг в
`/etc/node-agent/config.json`, вшитый CP public key рядом, one-time токен в файл
`bootstrap_token_path`. При первом старте агент делает `Register` по токену
(Bearer, не mTLS — cert-а может ещё не быть), отдаёт Reality public key/shortIds,
получает identity. Дальше — стационарный mTLS-цикл.

Пример `config.json`:

```json
{
  "control_plane_url": "https://cp.example.net",
  "client_cert_path": "/etc/node-agent/client.crt",
  "client_key_path": "/etc/node-agent/client.key",
  "cp_public_key_path": "/etc/node-agent/cp-public.pem",
  "xray_config_path": "/etc/xray/config.json",
  "xray_systemd_unit": "xray.service",
  "reality_keypair_mode": "generate",
  "reality_private_key_path": "/var/lib/node-agent/reality.key",
  "agent_epoch": "",
  "node_id": "",
  "pull_interval": "30s",
  "state_dir": "/var/lib/node-agent",
  "bootstrap_token_path": "/etc/node-agent/bootstrap.token"
}
```

Любое поле переопределяется env-переменной `NODE_AGENT_<UPPER_SNAKE>`
(напр. `NODE_AGENT_CONTROL_PLANE_URL`). Уровень логов — `NODE_AGENT_LOG_LEVEL`
(`debug|info|warn|error`), формат — JSON (`log/slog`).

systemd-хардненинг — в `systemd/node-agent.service`. Агент запускается под
`node-agent`; для `systemctl restart xray.service` нужен polkit-rule (см.
комментарий в unit-файле).

## Идемпотентность и статистика

- **Конфиг** — по hash. `config_hash == applied_hash` → ничего не делаем.
  `applied-state.json` в `state_dir` переживает рестарт агента, так что рестарт
  без изменений не дёргает Xray зря.
- **Stats** — `report_id` вида `"<agent_epoch>:<seq>"`, монотонный. Durable
  буфер на диске переживает рестарт (high-water seq персистится отдельно, чтобы
  id не переиспользовались после дропа заacket-нутых). Отгрузка батчем → ждём
  `acked_report_id` → дропаем всё до него. `agent_epoch` меняется при
  ре-bootstrap, чтобы id не сталкивались с прошлой инкарнацией.

## Что тонкое в v1 и что TODO (M2)

- **Юзеры** — часть полного конфига. Любое изменение = перезапись + restart Xray.
  TODO(M2): live-дельта юзеров через Xray gRPC `HandlerService.AlterInbound`
  (add/remove без разрыва соединений), restart только при изменении не-user частей.
- **Stats-чтение не реализовано.** `xray.Stats()` — заглушка. TODO(M2): Xray gRPC
  `StatsService.QueryStats(reset=true)` → `stats.Buffer.Append`. `reset=true`
  деструктивен (обнуляет счётчик при чтении) — дельту надо задёрсить на диск до
  следующего чтения, иначе байты теряются при краше.
- **gRPC/bidi-стрим не тянем.** Никаких внешних зависимостей: только stdlib.
- Буфер stats — snapshot-перезапись файла (корректно, но не оптимально).
  TODO(M2): append-only log + компакция, fsync перед rename.
- Register возвращает issued mTLS client-cert — TODO: персистить и переключаться
  на него. Сейчас cert берётся из путей в конфиге.

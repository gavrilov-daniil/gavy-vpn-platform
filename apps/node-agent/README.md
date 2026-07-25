# node-agent

Демон на VPN-ноде. Держит локальный Xray сходящимся с желаемым состоянием
(desired state), которое отдаёт control-plane. Один статический бинарь
(`CGO_ENABLED=0`), только stdlib, без Docker. Работает под systemd с хардненингом.

## Что делает (v1, тонкий)

Цикл reconcile каждые `pull_interval`:

1. **pull** — агент сам дозванивается (dial-out) до control-plane по HTTPS и
   запрашивает desired state. Панель на ноду **не ходит**: ноде нужен только
   исходящий 443, входящих портов управления нет.
2. **verify** — если ответ пришёл подписанным, подпись проверяется (RS256) по
   запинненному public key control-plane. См. «Подпись и mTLS».
3. **apply (по hash, идемпотентно)** — если `configHash != applied_hash`:
   подставить локальный приватник Reality, записать весь Xray-конфиг в файл
   (атомарно) и `systemctl restart` Xray. Если hash совпал — no-op.
4. **report** — вернуть observed state: `appliedConfigHash`, версии (агент/Xray),
   sysStats.
5. **ship stats** — отгрузить накопленные батчи статистики отдельным запросом.

Если control-plane офлайн — агент продолжает крутить последний применённый
конфиг и не падает; неудачный проход просто логируется.

## API control-plane

Все запросы несут заголовок `x-agent-token: <agent_token>`; `nodeId` берётся из
конфига агента.

| Метод | Путь | Тело / ответ |
|---|---|---|
| GET | `/internal/agent/nodes/{nodeId}/desired-state` | ответ: `{version, configHash, config, users, generatedAt}` |
| POST | `/internal/agent/nodes/{nodeId}/report` | тело: `{appliedConfigHash, agentVersion, xrayVersion, sysStats}` → `{ok:true}` |
| POST | `/internal/agent/nodes/{nodeId}/stats` | тело: `{reportId, deltas[]}` → `{accepted, applied}` |

Desired state:

```json
{
  "version": 42,
  "configHash": "<sha256 canonical json конфига>",
  "config": { "...весь Xray-конфиг ноды..." },
  "users": [ { "email": "a@b.c", "uuid": "...", "level": 0 } ],
  "generatedAt": "2026-07-26T10:00:00.000Z"
}
```

Дельта статистики: `{subjectType: "user"|"inbound"|"outbound", subjectKey,
upDelta, downDelta, windowStart, windowEnd}`. Имена счётчиков Xray
(`user>>>...>>>traffic>>>uplink`) схлопываются в одну дельту на субъект.

`accepted: false` — **не ошибка**: этот `reportId` control-plane уже принимал.
Батч дропается из буфера, ретрай запрещён — он вернёт то же самое.

## Подпись и mTLS (оба опциональны)

- **mTLS.** Заданы `client_cert_path` и `client_key_path` — агент ходит с
  клиентским сертификатом (и требует TLS 1.3). Пустые — обычный HTTPS
  (нижняя граница TLS 1.2). Аутентификация в обоих случаях — `x-agent-token`.
  Пути задаются только вместе: половина mTLS — ошибка конфига.
- **Подпись desired-state.** Механизм — root of trust агента, но control-plane
  пока не подписывает и отдаёт голый JSON. Правило анти-даунгрейда:
  - пришёл конверт `{payload, signature}` → подпись проверяется всегда;
  - пришёл голый JSON → принимается, **только если** `cp_public_key_path` пуст;
  - ключ задан, подписи нет → ошибка (иначе подпись снималась бы удалением поля);
  - конверт есть, ключа нет → ошибка (проверить нечем).

  Ошибка на этом шаге не роняет агента: нода продолжает крутить последний
  применённый конфиг, а проход логируется как неудачный.

## Reality private key

Приватник Reality **никогда не покидает ноду**: control-plane его не знает, и в
`realitySettings.privateKey` приходит плейсхолдер `__REALITY_PRIVATE_KEY__`.
Агент подставляет туда содержимое `reality_private_key_path` при записи конфига —
без подстановки Xray не стартует. Замена делается на уровне байт, конфиг доезжает
до файла ровно таким, каким его собрал control-plane.

Reality public key вшит в строку подключения каждого клиента как `pbk=`. Если он
меняется — рвутся **все** существующие клиенты. Поэтому `reality_keypair_mode`:

- `generate` — обычный bootstrap. Генерит x25519 keypair, **только если его ещё
  нет**. При повторном запуске переиспользует существующий (pbk не вращается).
- `import` — **миграция существующей ноды (P0)**. Читает приватник из
  `reality_private_key_path`. **Никогда не генерит**: отсутствие файла — жёсткая
  ошибка, а не молчаливая генерация нового ключа (иначе сменится pbk).

## Конфиг

```json
{
  "control_plane_url": "https://cp.example.net",
  "node_id": "00000000-0000-0000-0000-000000000000",
  "agent_token": "<общий секрет, тот же что AGENT_TOKEN в core>",
  "client_cert_path": "",
  "client_key_path": "",
  "cp_public_key_path": "",
  "xray_config_path": "/etc/xray/config.json",
  "xray_systemd_unit": "xray.service",
  "reality_keypair_mode": "generate",
  "reality_private_key_path": "/var/lib/node-agent/reality.key",
  "agent_epoch": "",
  "pull_interval": "30s",
  "state_dir": "/var/lib/node-agent"
}
```

Обязательные: `control_plane_url`, `node_id`, `agent_token`, `xray_config_path`,
`reality_private_key_path`, `state_dir`.

Любое поле переопределяется env-переменной `NODE_AGENT_<UPPER_SNAKE>`
(напр. `NODE_AGENT_CONTROL_PLANE_URL`, `NODE_AGENT_AGENT_TOKEN`). Уровень логов —
`NODE_AGENT_LOG_LEVEL` (`debug|info|warn|error`), формат — JSON (`log/slog`).

systemd-хардненинг — в `systemd/node-agent.service`. Агент запускается под
`node-agent`; для `systemctl restart xray.service` нужен polkit-rule (см.
комментарий в unit-файле).

## Идемпотентность и статистика

- **Конфиг** — по hash. `configHash == applied_hash` → ничего не делаем.
  `applied-state.json` в `state_dir` переживает рестарт агента, так что рестарт
  без изменений не дёргает Xray зря.
- **Stats** — `report_id` вида `"<agent_epoch>:<seq>"`, монотонный. Durable
  буфер на диске переживает рестарт (high-water seq персистится отдельно, чтобы
  id не переиспользовались после дропа принятых). Батчи уходят по одному →
  `accepted` любой (true/false) → дропаем батч. `agent_epoch` меняется при
  ре-bootstrap, чтобы id не сталкивались с прошлой инкарнацией.

## Что тонкое в v1 и что TODO (M2)

- **Юзеры** — часть полного конфига. Любое изменение = перезапись + restart Xray.
  TODO(M2): live-дельта юзеров через Xray gRPC `HandlerService.AlterInbound`
  (add/remove без разрыва соединений), restart только при изменении не-user частей.
- **Stats-чтение не реализовано.** `xray.Stats()` — заглушка, поэтому буфер в v1
  обычно пуст. TODO(M2): Xray gRPC `StatsService.QueryStats(reset=true)` →
  `stats.Buffer.Append`. `reset=true` деструктивен (обнуляет счётчик при чтении) —
  дельту надо задёрсить на диск до следующего чтения, иначе байты теряются при краше.
- **gRPC/bidi-стрим не тянем.** Никаких внешних зависимостей: только stdlib.
- Буфер stats — snapshot-перезапись файла (корректно, но не оптимально).
  TODO(M2): append-only log + компакция, fsync перед rename.
- **Bootstrap-хендшейка нет.** На сервере нет эндпоинта регистрации: `node_id`,
  `agent_token` и `agent_epoch` кладутся в конфиг при раскатке ноды. TODO: выдача
  identity и mTLS-сертификата одноразовым токеном.

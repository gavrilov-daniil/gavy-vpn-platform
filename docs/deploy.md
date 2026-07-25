# Развёртывание

Платформа ставится на **отдельный хост**, а не рядом с действующей панелью. Причины две: на одной машине не хватит памяти (у панели уже 1 ГБ впритык со свопом), и два control-plane не должны управлять одними нодами — они начнут драться за список пользователей в одном Xray-inbound (`migration.md`, cutover).

Хост желательно вне РФ: там же лежит ключ подписи desired-state и креды мерчантов, а «Антифрод 2.0» делает изъятие РФ-хостинга реальным риском (`security.md`).

## Что разворачивается

| Сервис | Роль | Наружу |
|---|---|---|
| `caddy` | TLS, маршрутизация, статика админки | 80/443 |
| `core` | API, выдача подписки, вебхуки | через caddy |
| `worker` | тот же образ, `INSTANCE_TYPE=worker`: cron и очередь | нет |
| `bot` | два Telegram-бота | вебхук через caddy |
| `postgres`, `redis` | данные и очереди | нет, только внутри сети |

Админка — статика, собирается в volume и отдаётся caddy.

## Минимальные требования

2 vCPU / 4 ГБ / 40 ГБ. Меньше не стоит: Postgres, Redis и три Node-процесса. Docker и Docker Compose v2.

## Порядок

```bash
git clone https://github.com/gavrilov-daniil/gavy-vpn-platform.git
cd gavy-vpn-platform
cp .env.example .env
```

Заполнить `.env`. Обязательное, без чего core не стартует или раздел закрыт:

| Переменная | Смысл |
|---|---|
| `POSTGRES_PASSWORD` | пароль БД |
| `SECRETS_MASTER_KEY` | ключ шифрования кредов мерчантов, **минимум 16 символов**; смена делает сохранённые ключи нечитаемыми |
| `ADMIN_TOKEN` | переходный вход в админку; после заведения учёток оператора можно убрать |
| `SERVICE_TOKEN` | общий секрет core↔бот |
| `AGENT_TOKEN` | переходный секрет агентов; после энроллмента всех нод убрать |
| `SUB_PUBLIC_HOST` | **домен подписки — менять нельзя**, он зашит в сохранённых у клиентов ссылках |
| `ADMIN_PUBLIC_HOST` | отдельный домен админки |
| `BOT_TOKEN`, `BOT_WEBHOOK_SECRET` | клиентский бот; при заданном `BOT_WEBHOOK_URL` секрет обязателен, иначе бот не стартует |

Запуск:

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml run --rm migrate
```

Проверка:

```bash
curl -s https://$SUB_PUBLIC_HOST/healthz            # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' https://$ADMIN_PUBLIC_HOST/api/admin/merchants   # 401 без токена — так и должно быть
```

## Первые шаги в админке

1. Завести оператора и уйти с общего токена:
   ```bash
   curl -X POST https://$ADMIN_PUBLIC_HOST/api/admin/auth/operators \
     -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"email":"you@example.com","password":"…","role":"admin"}'
   ```
   После этого `ADMIN_TOKEN` из `.env` стоит убрать и перезапустить core.
2. Подключить мерчантов (экран «Мерчанты»): ключи шифруются при сохранении, включение — тумблером, без рестарта.
3. Завести ноды, выпустить bootstrap-токены, поставить агентов (`apps/node-agent/README.md`).

## Перенос данных с действующей панели

```bash
# в .env: REMNAWAVE_URL и REMNAWAVE_TOKEN (только чтение)
curl -X POST https://$ADMIN_PUBLIC_HOST/api/admin/import/remnawave \
  -H "x-admin-token: …" -H 'content-type: application/json' -d '{}'          # dry-run
curl -X POST … -d '{"apply":true,"withDevices":true}'                        # запись
```

Импорт идемпотентен: повторный прогон обновляет и не двоит. Идентичность (`short_uuid`, `vless_uuid`) переносится дословно — иначе клиенты молча отвалятся.

## Обновление

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml run --rm migrate
```

Миграции применяются отдельной командой, а не на старте контейнера: иначе два одновременно поднявшихся инстанса накатывали бы их параллельно.

## Резервные копии

Ценное — Postgres и `SECRETS_MASTER_KEY`. Без ключа дамп бесполезен для восстановления мерчантов; без дампа ключ бесполезен. Хранить раздельно.

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U vpn vpn_platform | gzip > backup-$(date +%F).sql.gz
```

Reality-приватники нод в БД **не хранятся** — они только на нодах. Резервная копия платформы их не содержит, и потеря ноды означает потерю её ключа: см. `migration.md` про импорт ключа при перехвате.

## Что не автоматизировано

- Переключение DNS домена подписки на новый хост — ручной шаг, делается после того, как golden-diff сошёлся и ноды перехвачены.
- Раскладка приватного ключа Reality на ноду при перехвате (режим `import`) — ручной шаг оператора.
- mTLS между агентом и core: серверной половины нет, аутентификация по per-node токену.

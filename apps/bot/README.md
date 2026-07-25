# @vpn/bot

Два Telegram-бота в одном процессе:

- **Клиентский** (`BOT_TOKEN`) — продажи и самообслуживание: тарифы, оплата, пробный период, баланс, рефералка, устройства, поддержка. Роутинг на grammy.
- **Админский/алертовый** (`ADMIN_BOT_TOKEN` + `ADMIN_CHAT_ID`) — односторонние уведомления операторам: новый платёж, нода упала, провижнинг сломался, скоро продление сервера. Роутинга нет, только `sendMessage` / `editMessageText` через HTTP API Telegram.

Бот **тонкий**: своей БД нет, всё состояние — в core (`CORE_API_URL`). Сцен и session нет, весь стейт экрана лежит в `callback_data`.

## Запуск

Только из собранного `dist` — NestJS DI требует `emitDecoratorMetadata`, которую esbuild/tsx не эмитит.

```bash
pnpm --filter @vpn/bot build
pnpm --filter @vpn/bot start     # node dist/main.js
pnpm --filter @vpn/bot dev       # tsc --watch + node --watch dist/main.js
```

## Транспорт: webhook vs polling

Выбор по наличию `BOT_WEBHOOK_URL`:

- **задан** → `setWebhook(url, {secret_token, allowed_updates:[message, callback_query, pre_checkout_query], drop_pending_updates:false})`. Апдейты приходят на `POST /tg`, заголовок `x-telegram-bot-api-secret-token` сверяется constant-time до разбора тела.
- **не задан** → long polling (локальная разработка). Перед стартом снимается ранее установленный вебхук, иначе Telegram отдаёт 409 на `getUpdates`.

`drop_pending_updates: false` осознанно: за деплой могли накопиться оплаты и обращения.

## Env

| Переменная | Обяз. | По умолчанию | Назначение |
|---|---|---|---|
| `BOT_TOKEN` | да | — | токен клиентского бота (без него процесс не стартует) |
| `BOT_PORT` | нет | `3300` | порт HTTP-сервера бота |
| `BOT_WEBHOOK_URL` | нет | пусто | публичный URL вебхука; пусто → polling |
| `BOT_WEBHOOK_SECRET` | да при webhook | пусто | секрет заголовка `x-telegram-bot-api-secret-token` |
| `CORE_API_URL` | нет | `http://localhost:3100` | база core API |
| `SERVICE_TOKEN` | да | пусто | общий секрет для `/bot/*` и вызовов бот → core. Пустой = эндпоинты закрыты полностью |
| `ADMIN_BOT_TOKEN` | нет | пусто | токен алертового бота; пусто → алерты пропускаются |
| `ADMIN_CHAT_ID` | нет | пусто | чат операторов для алертов |
| `BOT_TOPUP_AMOUNTS` | нет | `500,1000,2500,5000` | суммы пополнения в рублях |
| `BOT_HAPP_INSTALL_URL` | нет | `https://happ.su/` | ссылка на установку клиента |

## HTTP-эндпоинты бота

| Метод | Путь | Авторизация | Назначение |
|---|---|---|---|
| POST | `/tg` | `x-telegram-bot-api-secret-token` | вебхук Telegram |
| POST | `/bot/notify` | `x-service-token` | `{tgId, text, buttons?}` — ответ оператора, транзакционное уведомление |
| POST | `/bot/broadcast-send` | `x-service-token` | то же, для рассыльщика; результат типизован по причинам |
| POST | `/bot/alert` | `x-service-token` | `{text, silent?}` → алерт операторам, возвращает `messageId` |
| POST | `/bot/alert/edit` | `x-service-token` | `{messageId, text}` — правка алерта («инцидент закрыт») |
| GET | `/healthz` | — | проверка живости |

Результат отправки (`notify` / `broadcast-send`):

```ts
{ ok: true, messageId } | { ok: false, reason: "blocked" | "rate_limited" | "error", retryAfter?, detail? }
```

403 → `blocked` (фейлим получателя), 429 → `rate_limited` + `retryAfter` (пауза кампании), остальное → `error`. Кампания не должна падать целиком из-за одного заблокировавшего бота получателя.

## Экраны и callback'и

```
menu:home | menu:plans | menu:status | menu:trial | menu:balance | menu:refer
menu:support | menu:devices | menu:instructions
plan:<planShort>                      — карточка тарифа
pay:<merchantShort>:<planShort>       — оплата тарифа
topup:<merchantShort>:<amountKopeks>  — пополнение баланса
trial:activate
```

**Важно про `<...Short>`.** В `callback_data` Telegram влезает 64 байта, а `pay:<uuid>:<uuid>` — это 77. Поэтому в кнопку кладётся первые 8 hex-символов id, а полный id восстанавливается по списку из core (`shortId` / `pickByShort` в `src/bot/ui.ts`). Неоднозначный префикс трактуется как промах — юзеру показывается «кнопка устарела», а не случайный объект.

Способы оплаты **не захардкожены**: приходят из `GET /v1/payments/methods/plan|topup` (там уже отфильтрованы включённые и настроенные мерчанты). Ответ `POST /v1/payments/create` разветвляется на `payUrl` (кнопка-ссылка) или `deferredToBot` (Stars — счёт выставляет сам бот: `currency: XTR`, `provider_token: ""`).

## Идемпотентность

`buildIdempotencyKey` из `@vpn/core-kit` (окно 5 минут) считается по `telegram id + действие + параметры` и уходит в core заголовком `x-client-request-id`. Плюс барьер в памяти процесса от дабл-тапа. Барьер в памяти не переживает рестарт и не работает на втором инстансе — **несущий барьер именно дедуп в core**.

На запись ретраев нет (`retries: 0`): повтор создал бы второй платёж.

## Аналитика

`bot.use(...)` самым первым middleware, fire-and-forget в `POST /internal/bot-events/track`; падение аналитики не влияет на ответ юзеру. Маппинг апдейта в событие — чистая функция `eventFromUpdate()` в `src/bot/bot-events.ts` (таблица статических callback'ов + упорядоченные regex-правила). Текст сообщений в аналитику не уходит, только длина.

## Контракт core

Уже есть в `@vpn/core`:

- `GET /v1/payments/methods/:purpose`
- `POST /v1/payments/create`

Ожидаются ботом, но в core пока не реализованы:

- `POST /internal/subscribers/resolve` → `{subscriberId, isNew}`
- `GET /v1/plans` → `PlanDto[]`
- `GET /internal/subscribers/:id/overview` → баланс, подписка, рефералка, устройства, `trialAvailable`
- `POST /internal/subscriptions/trial`
- `POST /internal/payments/stars/pre-checkout` → `{ok, reason?}`
- `POST /internal/payments/stars/confirm` → `{ok, alreadyProcessed?, planTitle?, expireAt?}`
- `POST /internal/support/inbound`
- `POST /internal/bot-events/track`

Все `/internal/*` вызываются с заголовком `x-service-token`, записи — ещё и с `x-client-request-id`.

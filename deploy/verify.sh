#!/usr/bin/env bash
# Проверки живого стенда. Один и тот же файл гоняется в CI против эфемерного стенда
# и на хосте после релиза: расхождение между «проверено в CI» и «проверено в проде»
# — это ровно тот класс дефектов, из-за которого деплой-джоба и появилась.
#
#   SUB_HOST=sub.example.com ADMIN_HOST=admin.example.com EXPECT_VERSION=abc1234 ./verify.sh
#
# RESOLVE_IP непусто — режим стенда: домены резолвятся в этот адрес, цепочка TLS
# не проверяется (сертификата на *.localhost не существует).
#
# BOT_ENABLED повторяет флаг из .env: при true бот обязан отвечать, иначе — обязан
# отсутствовать. Проверяются оба случая: «выключен» — это тоже утверждение о стенде.
set -euo pipefail

SUB_HOST=${SUB_HOST:?нужен SUB_HOST}
ADMIN_HOST=${ADMIN_HOST:?нужен ADMIN_HOST}
EXPECT_VERSION=${EXPECT_VERSION:-}
RESOLVE_IP=${RESOLVE_IP:-}
WAIT_TIMEOUT=${VERIFY_TIMEOUT:-90}

curl_opts=(-s --max-time 10)
if [ -n "$RESOLVE_IP" ]; then
  curl_opts+=(-k --resolve "$SUB_HOST:443:$RESOLVE_IP" --resolve "$ADMIN_HOST:443:$RESOLVE_IP")
fi

failed=0
ok() { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1"; failed=1; }

# `|| true` несущий: при недоступном апстреме curl выходит ненулевым, и под set -e
# скрипт падал бы молча, до строки с результатом. Код при этом печатается свой — 000.
code_of() { curl "${curl_opts[@]}" -o /dev/null -w '%{http_code}' "$@" || true; }

echo "verify: sub=$SUB_HOST admin=$ADMIN_HOST version=${EXPECT_VERSION:-<не сверяем>}"

# 1. core вообще поднялся
deadline=$((SECONDS + WAIT_TIMEOUT))
health=""
while [ $SECONDS -lt $deadline ]; do
  health=$(curl "${curl_opts[@]}" "https://$SUB_HOST/healthz" || true)
  case "$health" in *'"ok":true'*) break ;; esac
  sleep 3
done
case "$health" in
  *'"ok":true'*) ok "/healthz отвечает" ;;
  *) bad "/healthz не ответил за ${WAIT_TIMEOUT}s (последний ответ: ${health:-пусто})"; exit 1 ;;
esac

# 2. Поднялся именно выкатываемый образ. Без этой сверки «compose вернул 0, но
# контейнер остался прежним» неотличимо от успешного релиза.
if [ -n "$EXPECT_VERSION" ]; then
  running=$(printf '%s' "$health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
  if [ "$running" = "$EXPECT_VERSION" ]; then
    ok "core на версии $running"
  else
    bad "core на версии '${running:-неизвестна}', ожидалась '$EXPECT_VERSION' — контейнер не пересоздался"
  fi

  # Статика админки лежит в volume и переживает пересборку образа: её отдельно
  # легко оставить от прошлого релиза и не заметить.
  admin_version=$(curl "${curl_opts[@]}" "https://$ADMIN_HOST/version.txt" | tr -d '[:space:]' || true)
  if [ "$admin_version" = "$EXPECT_VERSION" ]; then
    ok "статика админки на версии $admin_version"
  else
    bad "статика админки на версии '${admin_version:-неизвестна}', ожидалась '$EXPECT_VERSION'"
  fi
fi

# 3. Ручка агентов проксируется. 404 означал бы, что запрос не доходит до core
# и ни одна нода не подключится — на этом уже обжигались.
code=$(code_of -X POST "https://$SUB_HOST/internal/agent/enroll" -H 'content-type: application/json' -d '{}')
if [ "$code" = "404" ]; then
  bad "/internal/agent/enroll → 404: агенты не достучатся до core"
else
  ok "/internal/agent/enroll → $code (не 404)"
fi

# 4. Админский API не виден на домене подписки: случайно открытый путь там —
# это дамп базы подписчиков.
code=$(code_of "https://$SUB_HOST/api/admin/merchants")
if [ "$code" = "404" ]; then
  ok "админский API на домене подписки → 404"
else
  bad "админский API торчит на домене подписки → $code"
fi

# 5. На своём домене отвечает и требует токен
code=$(code_of "https://$ADMIN_HOST/api/admin/merchants")
if [ "$code" = "401" ]; then
  ok "админский API на своём домене → 401 без токена"
else
  bad "админский API на своём домене → $code, ожидался 401"
fi

# 6. Бот. Проверяется через /tg: единственная его ручка, выставленная наружу
# (остальное, /bot/*, живёт внутри docker-сети и снаружи недостижимо). Без секрета
# бот отвечает 401 — он проверяется до разбора тела, так что запрос ничего не делает,
# а 401 доказывает, что процесс жив и отвечает.
#
# Лежащий или крэш-цикличный бот даёт 502 от Caddy. Ровно этого не хватало: релиз
# уезжал зелёным, пока bot крутился в цикле «BOT_TOKEN не задан».
bot_code=$(code_of -X POST "https://$SUB_HOST/tg" -H 'content-type: application/json' -d '{}')
if [ "${BOT_ENABLED:-false}" = "true" ]; then
  case "$bot_code" in
    401) ok "бот отвечает на /tg → 401 без секрета" ;;
    404) bad "/tg → 404: маршрут бота не проксируется, Telegram не доставит ни одного апдейта" ;;
    000) bad "/tg не ответил за отведённое время: бот лежит или в крэш-цикле" ;;
    *) bad "/tg → $bot_code: бот не отвечает — контейнер лежит или в крэш-цикле" ;;
  esac
else
  # Флаг выключен, а бот отвечает — значит он остался от прошлого релиза: у него
  # свой BOT_TOKEN и своё поведение, и он продолжает обрабатывать клиентов.
  case "$bot_code" in
    401|200) bad "/tg → $bot_code при BOT_ENABLED≠true: бот поднят, хотя выключен" ;;
    *) ok "бот выключен (BOT_ENABLED≠true), /tg → $bot_code" ;;
  esac
fi

# Отдельной проверки /webhooks/* здесь нет намеренно: в Caddyfile они разобраны тем же
# матчером, что и /healthz, — прошедший пункт 1 доказывает и их маршрут. А постучаться
# в них по-настоящему нельзя: без подписи запрос уходит в обработчик мерчанта и
# оставляет за собой строку в логе платежей на каждом релизе.

exit $failed

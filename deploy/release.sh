#!/usr/bin/env bash
# Единственная точка выкатки. Вызывается из GitHub Actions по ssh (forced-command
# corelink-deploy) и руками — одинаково.
#
#   deploy/release.sh <git-sha>     выкатить ревизию
#   deploy/release.sh --rollback    вернуть предыдущую (digest'ы из release.prev.env)
#
# Порядок шагов не косметический:
#   1. compose config    — не хватает переменной в .env: падаем ДО того, как что-то тронули
#   2. pull              — сеть отработала до любых изменений на живом стенде
#   3. pg_dump           — единственная точка отката схемы, миграции назад не откатываются
#   4. migrate           — до старта нового кода, иначе новый код работает со старой схемой
#   5. up + verify       — не сошлось: автоматом возвращаем прошлые digest'ы
#
# Между 4 и 5 старый код короткое время работает с НОВОЙ схемой. Отсюда правило релиза:
# разрушающий DDL (drop column, not null на существующей колонке) едет отдельным
# релизом, после того как код, знавший старую схему, снят.
set -euo pipefail

DIR=${CORELINK_DIR:-/opt/corelink}
IMAGE_PREFIX=${IMAGE_PREFIX:-ghcr.io/gavrilov-daniil/corelink}
COMPOSE=(docker compose -f "$DIR/docker-compose.prod.yml")
RELEASE_ENV="$DIR/release.env"
PREV_ENV="$DIR/release.prev.env"
BACKUP_DIR=${BACKUP_DIR:-$DIR/backups}
BACKUP_KEEP=${BACKUP_KEEP:-10}
LOCK_FILE=${LOCK_FILE:-$DIR/.release.lock}

log() { printf '\n=== %s\n' "$*"; }
die() { printf '\nОШИБКА: %s\n' "$*" >&2; exit 1; }

# .env читается grep'ом, а не source: там лежит PEM ключа подписи desired-state
# с переносами строк, и попытка его исполнить роняет скрипт на ровном месте.
env_value() { sed -n "s/^$1=//p" "$DIR/.env" | tail -1 | sed 's/^"\(.*\)"$/\1/'; }

cd "$DIR"

# Два релиза одновременно = две параллельные попытки накатить миграции.
command -v flock >/dev/null || die "нет flock (util-linux) — без него релизы не сериализуются"
exec 9>"$LOCK_FILE"
flock -n 9 || die "релиз уже идёт (lock $LOCK_FILE)"

mode=${1:-}
[ -n "$mode" ] || die "нужен git-sha или --rollback"

if [ "$mode" = "--rollback" ]; then
  [ -f "$PREV_ENV" ] || die "нет $PREV_ENV — откатываться не к чему"
  set -a; . "$PREV_ENV"; set +a
  VERSION=${VERSION:?в release.prev.env нет VERSION}
  log "откат на $VERSION"
else
  VERSION=$mode
  CORE_IMAGE="$IMAGE_PREFIX-core:sha-$VERSION"
  BOT_IMAGE="$IMAGE_PREFIX-bot:sha-$VERSION"
  ADMIN_IMAGE="$IMAGE_PREFIX-admin:sha-$VERSION"
  export CORE_IMAGE BOT_IMAGE ADMIN_IMAGE
  log "релиз $VERSION"
fi

SUB_HOST=$(env_value SUB_PUBLIC_HOST)
ADMIN_HOST=$(env_value ADMIN_PUBLIC_HOST)
PG_USER=$(env_value POSTGRES_USER); PG_USER=${PG_USER:-vpn}
PG_DB=$(env_value POSTGRES_DB); PG_DB=${PG_DB:-vpn_platform}
[ -n "$SUB_HOST" ] && [ -n "$ADMIN_HOST" ] || die "в .env нет SUB_PUBLIC_HOST или ADMIN_PUBLIC_HOST"

# Бот — единственный сервис, который можно осознанно не поднимать: стенд без
# BOT_TOKEN живёт и без него. Решает флаг, а не наличие токена: «забыл токен» и
# «бот не нужен» должны различаться, иначе опечатка тихо снимает клиентского бота.
BOT_ENABLED=$(env_value BOT_ENABLED)
case "${BOT_ENABLED:-}" in
  true|1|yes)
    BOT_ENABLED=true
    [ -n "$(env_value BOT_TOKEN)" ] || die "BOT_ENABLED=true, но BOT_TOKEN пуст — бот уйдёт в крэш-цикл"
    COMPOSE+=(--profile bot)
    ;;
  *) BOT_ENABLED=false ;;
esac
export BOT_ENABLED

# --- 1. Конфигурация ------------------------------------------------------------
# Новая обязательная переменная, не заведённая в .env на хосте, иначе всплыла бы
# крэш-циклом контейнера уже после того, как старый снят.
log "проверка конфигурации"
"${COMPOSE[@]}" config -q || die "docker compose config: конфигурация или .env не раскрываются"

# --- 2. Образы ------------------------------------------------------------------
# Тег может быть перезаписан, digest — нет. Дальше по коду и в release.env едут
# только digest'ы: и текущий стенд, и точка отката описаны неизменяемо.
resolve_digest() {
  local digest
  digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$1" 2>/dev/null || true)
  [ -n "$digest" ] || die "у $1 нет RepoDigest — образ не получен из реестра"
  printf '%s' "$digest"
}

log "загрузка образов"
for image in "$CORE_IMAGE" "$BOT_IMAGE" "$ADMIN_IMAGE"; do
  docker pull -q "$image" >/dev/null || die "не скачался $image"
done
CORE_IMAGE=$(resolve_digest "$CORE_IMAGE")
BOT_IMAGE=$(resolve_digest "$BOT_IMAGE")
ADMIN_IMAGE=$(resolve_digest "$ADMIN_IMAGE")
export CORE_IMAGE BOT_IMAGE ADMIN_IMAGE
printf 'core:  %s\nbot:   %s\nadmin: %s\n' "$CORE_IMAGE" "$BOT_IMAGE" "$ADMIN_IMAGE"

# Точка отката — то, что работает ПРЯМО СЕЙЧАС, а не то, что записали в прошлый раз.
if [ "$mode" != "--rollback" ] && [ -f "$RELEASE_ENV" ]; then
  cp "$RELEASE_ENV" "$PREV_ENV"
fi

# --- 3. Дамп --------------------------------------------------------------------
log "база"
"${COMPOSE[@]}" up -d postgres redis
for _ in $(seq 1 45); do
  "${COMPOSE[@]}" exec -T postgres pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 && break
  sleep 2
done
"${COMPOSE[@]}" exec -T postgres pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 \
  || die "postgres не поднялся"

backup=""
if [ "${SKIP_BACKUP:-0}" != "1" ]; then
  log "дамп"
  mkdir -p "$BACKUP_DIR"
  backup="$BACKUP_DIR/pre-$VERSION-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  "${COMPOSE[@]}" exec -T postgres pg_dump -U "$PG_USER" "$PG_DB" | gzip > "$backup" \
    || die "pg_dump не отработал — без дампа миграции не накатываем"
  echo "$backup ($(du -h "$backup" | cut -f1))"
  ls -1t "$BACKUP_DIR"/pre-*.sql.gz 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) \
    | while read -r old; do rm -f "$old"; done
fi

# --- 4. Миграции ----------------------------------------------------------------
# Тем же образом, что поедет в core: иначе схему накатывает версия кода, отличная
# от разворачиваемой. Скрипт печатает journal=N applied=N и падает при расхождении —
# drizzle МОЛЧА пропускает миграцию с when меньше уже применённой.
log "миграции"
"${COMPOSE[@]}" run --rm migrate \
  || die "миграции не накатились; база между версиями, дамп: ${backup:-не снимался}"

# --- 5. Стенд -------------------------------------------------------------------
log "запуск"
"${COMPOSE[@]}" up -d --remove-orphans

log "проверка"
if SUB_HOST="$SUB_HOST" ADMIN_HOST="$ADMIN_HOST" EXPECT_VERSION="$VERSION" "$DIR/deploy/verify.sh"; then
  cat > "$RELEASE_ENV" <<EOF
VERSION=$VERSION
CORE_IMAGE=$CORE_IMAGE
BOT_IMAGE=$BOT_IMAGE
ADMIN_IMAGE=$ADMIN_IMAGE
RELEASED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
  docker image prune -f >/dev/null || true
  log "релиз $VERSION выкачен"
  exit 0
fi

# --- Откат ----------------------------------------------------------------------
# Выключенного бота в списке быть не должно: compose ответит «no such service» и
# не покажет логи остальных — ровно в момент, когда они и нужны.
log_services=(core caddy)
[ "$BOT_ENABLED" = "true" ] && log_services+=(bot)
"${COMPOSE[@]}" logs --tail=100 "${log_services[@]}" || true

[ "$mode" != "--rollback" ] || die "откат тоже не прошёл проверку — разбираться руками"
[ -f "$PREV_ENV" ] || die "проверка не прошла, откатываться не к чему — стенд остаётся на $VERSION"

log "проверка не прошла — откатываемся"
set -a; . "$PREV_ENV"; set +a
export CORE_IMAGE BOT_IMAGE ADMIN_IMAGE
"${COMPOSE[@]}" up -d --remove-orphans
SUB_HOST="$SUB_HOST" ADMIN_HOST="$ADMIN_HOST" EXPECT_VERSION="$VERSION" "$DIR/deploy/verify.sh" \
  || echo "откат выполнен, но проверки всё равно красные"

# Схема осталась мигрированной: старый код обязан её пережить (см. шапку файла).
die "релиз $mode откачен на $VERSION"

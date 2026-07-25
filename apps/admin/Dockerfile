# Админка — статика. Отдаёт её Caddy, здесь только сборка бандла.
FROM node:22-alpine AS builder
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile --filter @vpn/admin...

COPY apps/admin apps/admin
RUN pnpm --filter @vpn/admin build

# Результат забирает Caddy через volume-from или copy на этапе деплоя
FROM alpine:3.20 AS dist
WORKDIR /dist
COPY --from=builder /repo/apps/admin/dist ./
CMD ["true"]

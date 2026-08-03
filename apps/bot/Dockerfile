FROM node:22-alpine AS builder
WORKDIR /repo

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY apps/bot/package.json apps/bot/
COPY packages/core-kit/package.json packages/core-kit/
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps/bot apps/bot
RUN pnpm --filter @corelink/bot... build
RUN pnpm --filter @corelink/bot --prod deploy /app

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

ARG GIT_SHA=dev
ENV APP_VERSION=$GIT_SHA

RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /app ./

USER app
EXPOSE 3300

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BOT_PORT||3300)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]

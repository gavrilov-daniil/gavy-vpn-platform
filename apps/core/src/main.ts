import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger, type INestApplication } from "@nestjs/common";
import express, { type Request } from "express";
import { setAuditSink } from "@corelink/core-kit";
import { schema, type Database } from "@corelink/db";
import { AppModule } from "./app.module.js";
import { loadConfig } from "./config.js";
import { DB } from "./db/db.module.js";
import { JobRegistry } from "./workers/job.registry.js";
import { QueueService } from "./workers/queue.service.js";
import { SchedulerService } from "./workers/scheduler.service.js";

/** Тело обычного запроса. Дефолт body-parser'а (100 КБ) с запасом хватает всему публичному API. */
const PUBLIC_BODY_LIMIT = "256kb";
/**
 * Тело батча статистики от агента. На ноде с тысячей активных юзеров одна выгрузка —
 * это тысячи дельт, и на 100 КБ она получала 413. Отвергнутый батч раньше вставал
 * колом в очереди агента: учёт трафика по ноде замирал НАСОВСЕМ, а буфер рос.
 * Агент режет батч сам (stats.maxCountersPerEntry), этот лимит — второй рубеж.
 */
const AGENT_BODY_LIMIT = "8mb";
const AGENT_PATH_PREFIX = "/internal/agent";

/**
 * Парсеры тела регистрируются здесь вручную (`bodyParser: false` при create), потому
 * что штатный парсер Nest один на всё приложение: поднять лимит для агента можно было
 * бы только вместе с публичными эндпоинтами, а это 8 МБ на анонимный POST в /webhooks.
 *
 * `verify` повторяет то, что делает опция `rawBody: true` Nest: подписи вебхуков
 * провайдеров считаются по сырым байтам тела, а не по пересобранному JSON.
 *
 * Первым идёт парсер агента: body-parser выставляет `req._body` и следующий за ним
 * общий парсер уже ничего не делает.
 */
function installBodyParsers(app: INestApplication): void {
  const verify = (req: Request & { rawBody?: Buffer }, _res: unknown, buf: Buffer) => {
    if (Buffer.isBuffer(buf)) req.rawBody = buf;
  };
  app.use(AGENT_PATH_PREFIX, express.json({ limit: AGENT_BODY_LIMIT, verify }));
  app.use(express.json({ limit: PUBLIC_BODY_LIMIT, verify }));
  app.use(express.urlencoded({ extended: true, limit: PUBLIC_BODY_LIMIT, verify }));
}

/**
 * Аудит исходящих HTTP: core-kit маскирует секреты и зовёт этот приёмник, приёмник пишет строку.
 * Без подключения таблица external_api_log оставалась пустой, и разбирать «провайдер не ответил»
 * было нечем. Падение записи проглатывается в core-kit — аудит не должен ронять бизнес-вызов.
 */
function installAuditSink(db: Database, orgId: string): void {
  setAuditSink(async (record) => {
    await db.insert(schema.externalApiLog).values({
      orgId,
      provider: record.provider,
      endpoint: record.endpoint,
      method: record.method,
      requestBody: record.requestBody ?? null,
      responseBody: record.responseBody ?? null,
      statusCode: record.statusCode,
      durationMs: record.durationMs,
      attempts: record.attempts,
      correlationId: record.correlationId,
      errorMessage: record.errorMessage,
    });
  });
}

async function bootstrap() {
  const cfg = loadConfig();
  const log = new Logger("bootstrap");

  // Ключ шифрования кредов мерчантов. Дефолта тут быть не может: со значением
  // из публичного репозитория дамп БД расшифровывается кем угодно. Падаем сразу,
  // а не после того, как боевые ключи лягут «зашифрованными» известным ключом.
  if (!cfg.secretsMasterKey) {
    log.error("SECRETS_MASTER_KEY не задан — креды мерчантов шифровать нечем");
    process.exit(1);
  }
  if (cfg.secretsMasterKey.length < 16) {
    log.error("SECRETS_MASTER_KEY короче 16 символов — так шифровать боевые ключи нельзя");
    process.exit(1);
  }

  if (cfg.instanceType === "worker") {
    // тот же контекст, что у api, но без HTTP: консьюмер очереди + cron-эмиттер на лидере
    const ctx = await NestFactory.createApplicationContext(AppModule);
    ctx.enableShutdownHooks();
    installAuditSink(ctx.get<Database>(DB), cfg.defaultOrgId);

    const registry = ctx.get(JobRegistry);
    const queue = ctx.get(QueueService);
    const scheduler = ctx.get(SchedulerService);

    const started = queue.startWorker((name) => registry.run(name));
    if (!started) {
      log.error("worker без Redis бессмысленен: задайте REDIS_URL");
      await ctx.close();
      return;
    }
    await scheduler.start();
    log.log(`core worker запущен (org=${cfg.defaultOrgId})`);
    return;
  }

  // Пустой ADMIN_TOKEN — целевой режим: операторы входят учётками. Но пока ни одной
  // учётки нет, он единственный способ завести первую, и без предупреждения «админка
  // не открывается» дебажили бы по 401 в браузере. Заданный — наоборот, обходит роли.
  if (!cfg.adminToken) {
    log.warn("ADMIN_TOKEN не задан: вход в /api/admin/* только учёткой оператора");
  } else {
    log.warn("ADMIN_TOKEN задан: он даёт права superadmin в обход ролей — уберите после заведения учёток");
  }
  if (!cfg.serviceToken) {
    log.error("SERVICE_TOKEN не задан: любой запрос к /internal/* получит 401");
  }
  // Общий токен парка — переходный режим до энроллмента всех нод: он даёт доступ
  // к desired-state ЛЮБОЙ ноды, поэтому изъятие одной ноды вскрывает весь парк.
  if (cfg.agentToken) {
    log.warn(
      "AGENT_TOKEN задан: общий токен парка принимается от нод БЕЗ энроллмента (переходный режим). " +
        "Проведите ноды через POST /api/admin/nodes/:id/enrollment и уберите переменную",
    );
  }

  const app = await NestFactory.create(AppModule, { bodyParser: false });
  installBodyParsers(app);
  installAuditSink(app.get<Database>(DB), cfg.defaultOrgId);
  await app.listen(cfg.port);
  log.log(`core api on :${cfg.port} (org=${cfg.defaultOrgId})`);
}

void bootstrap();

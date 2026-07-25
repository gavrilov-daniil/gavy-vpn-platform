import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { setAuditSink } from "@vpn/core-kit";
import { schema, type Database } from "@vpn/db";
import { AppModule } from "./app.module.js";
import { loadConfig } from "./config.js";
import { DB } from "./db/db.module.js";
import { JobRegistry } from "./workers/job.registry.js";
import { QueueService } from "./workers/queue.service.js";
import { SchedulerService } from "./workers/scheduler.service.js";

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

  // Пустой токен = раздел закрыт целиком (fail-closed). Кричим при старте, иначе
  // «админка не открывается» будут дебажить по 401 в браузере.
  if (!cfg.adminToken) {
    log.error("ADMIN_TOKEN не задан: любой запрос к /api/admin/* получит 401");
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

  // rawBody нужен для проверки подписей вебхуков по сырым байтам тела
  const app = await NestFactory.create(AppModule, { rawBody: true });
  installAuditSink(app.get<Database>(DB), cfg.defaultOrgId);
  await app.listen(cfg.port);
  log.log(`core api on :${cfg.port} (org=${cfg.defaultOrgId})`);
}

void bootstrap();

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module.js";
import { loadConfig } from "./config.js";
import { JobRegistry } from "./workers/job.registry.js";
import { QueueService } from "./workers/queue.service.js";
import { SchedulerService } from "./workers/scheduler.service.js";

async function bootstrap() {
  const cfg = loadConfig();
  const log = new Logger("bootstrap");

  if (cfg.instanceType === "worker") {
    // тот же контекст, что у api, но без HTTP: консьюмер очереди + cron-эмиттер на лидере
    const ctx = await NestFactory.createApplicationContext(AppModule);
    ctx.enableShutdownHooks();

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

  // rawBody нужен для проверки подписей вебхуков по сырым байтам тела
  const app = await NestFactory.create(AppModule, { rawBody: true });
  await app.listen(cfg.port);
  log.log(`core api on :${cfg.port} (org=${cfg.defaultOrgId})`);
}

void bootstrap();

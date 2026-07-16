import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module.js";
import { loadConfig } from "./config.js";

async function bootstrap() {
  const cfg = loadConfig();
  const log = new Logger("bootstrap");

  if (cfg.instanceType === "worker") {
    // M0: воркер-режим — заглушка. Очереди BullMQ и cron-эмиттер (leader-lock) — M1.
    log.log("worker mode: очереди появятся в M1 (BullMQ)");
    return;
  }

  const app = await NestFactory.create(AppModule);
  await app.listen(cfg.port);
  log.log(`core api on :${cfg.port} (org=${cfg.defaultOrgId})`);
}

void bootstrap();

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module.js";
import { loadConfig } from "./config.js";

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule);
  await app.listen(cfg.port);

  new Logger("bootstrap").log(
    `bot api on :${cfg.port} (транспорт: ${cfg.webhookUrl ? "webhook" : "polling"}, core: ${cfg.coreApiUrl})`,
  );
}

void bootstrap();

import { Controller, Get, Module } from "@nestjs/common";
import { BotService } from "./bot/bot.service.js";
import { BotController } from "./bot/bot.controller.js";
import { NotifyController } from "./bot/notify.controller.js";
import { CoreApiClient } from "./core-api/core-api.client.js";
import { AdminBotClient } from "./admin-bot/admin-bot.client.js";

@Controller()
class HealthController {
  @Get("healthz")
  health() {
    return { ok: true, version: process.env.APP_VERSION ?? "dev" };
  }
}

@Module({
  controllers: [BotController, NotifyController, HealthController],
  providers: [BotService, CoreApiClient, AdminBotClient],
})
export class AppModule {}

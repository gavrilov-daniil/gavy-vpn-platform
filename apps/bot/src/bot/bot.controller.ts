import { Body, Controller, Headers, HttpCode, Logger, Post, UnauthorizedException } from "@nestjs/common";
import { safeCompare } from "@vpn/core-kit";
import type { Update } from "grammy/types";
import { loadConfig } from "../config.js";
import { BotService } from "./bot.service.js";

@Controller()
export class BotController {
  private readonly log = new Logger(BotController.name);
  private readonly cfg = loadConfig();

  constructor(private readonly bot: BotService) {}

  /**
   * Вебхук Telegram. Секрет проверяется ДО разбора тела: эндпоинт публичный.
   * Пустой секрет = раздел закрыт целиком (fail-closed): в режиме polling сюда не должен
   * приходить никто, а в режиме webhook пустой секрет не даст стартовать (см. loadConfig).
   * Ошибка обработки не должна превращаться в не-200 — иначе Telegram уйдёт в ретраи
   * и будет доставлять тот же апдейт по кругу.
   */
  @Post("tg")
  @HttpCode(200)
  async webhook(
    @Headers("x-telegram-bot-api-secret-token") secret: string | undefined,
    @Body() update: Update,
  ): Promise<{ ok: true }> {
    if (!this.cfg.webhookSecret || !safeCompare(secret ?? "", this.cfg.webhookSecret)) {
      throw new UnauthorizedException();
    }

    try {
      await this.bot.handleUpdate(update);
    } catch (err) {
      this.log.error(`update ${update.update_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ok: true };
  }
}

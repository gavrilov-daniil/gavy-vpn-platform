import { Body, Controller, Headers, HttpCode, Post, UnauthorizedException } from "@nestjs/common";
import { safeCompare } from "@corelink/core-kit";
import { loadConfig } from "../config.js";
import { AdminBotClient } from "../admin-bot/admin-bot.client.js";
import { BotService, type NotifyButton, type SendResult } from "./bot.service.js";

interface NotifyBody {
  tgId: number;
  text: string;
  buttons?: NotifyButton[];
}

/** Обратный канал core → бот: ответы оператора, транзакционные уведомления, рассылки, алерты. */
@Controller("bot")
export class NotifyController {
  private readonly cfg = loadConfig();

  constructor(
    private readonly bot: BotService,
    private readonly admin: AdminBotClient,
  ) {}

  @Post("notify")
  @HttpCode(200)
  notify(@Headers("x-service-token") token: string | undefined, @Body() body: NotifyBody): Promise<SendResult> {
    this.assertServiceToken(token);
    return this.bot.sendToUser(body.tgId, body.text, body.buttons);
  }

  /**
   * Отдельная ручка для рассыльщика: тот же вызов, но результат типизован по причинам отказа.
   * Кампания не должна падать целиком из-за одного заблокировавшего бота получателя.
   */
  @Post("broadcast-send")
  @HttpCode(200)
  broadcastSend(
    @Headers("x-service-token") token: string | undefined,
    @Body() body: NotifyBody,
  ): Promise<SendResult> {
    this.assertServiceToken(token);
    return this.bot.sendToUser(body.tgId, body.text, body.buttons);
  }

  /** Алерт операторам через второй бот (нода упала, провижнинг сломался, продление сервера). */
  @Post("alert")
  @HttpCode(200)
  async alert(
    @Headers("x-service-token") token: string | undefined,
    @Body() body: { text: string; silent?: boolean },
  ): Promise<{ ok: boolean; messageId: number | null }> {
    this.assertServiceToken(token);
    const messageId = await this.admin.sendAlert(body.text, { silent: body.silent });
    return { ok: messageId !== null, messageId };
  }

  /** Правка уже отправленного алерта — «инцидент закрыт» без нового сообщения в чате. */
  @Post("alert/edit")
  @HttpCode(200)
  async editAlert(
    @Headers("x-service-token") token: string | undefined,
    @Body() body: { messageId: number; text: string },
  ): Promise<{ ok: boolean }> {
    this.assertServiceToken(token);
    return { ok: await this.admin.editAlert(body.messageId, body.text) };
  }

  /** Незаданный SERVICE_TOKEN — это не «выключенная проверка», а закрытый эндпоинт. */
  private assertServiceToken(token: string | undefined): void {
    if (!this.cfg.serviceToken || !safeCompare(token ?? "", this.cfg.serviceToken)) {
      throw new UnauthorizedException();
    }
  }
}

import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { BotClient } from "../bot/bot.client.js";
import { CONVERSATION_STATUSES, SupportService, type ConversationStatus } from "./support.service.js";

@Controller()
export class SupportController {
  constructor(
    private readonly support: SupportService,
    private readonly bot: BotClient,
  ) {}

  /** Приём сообщения от бота. Дедуп по telegram_update_id — бот может переслать апдейт повторно. */
  @Post("internal/support/inbound")
  inbound(
    @Body()
    body: {
      telegramUserId: number;
      username?: string;
      text: string;
      /** Бот шлёт updateId; telegramUpdateId принимается как синоним. */
      updateId?: number;
      telegramUpdateId?: number;
      telegramMessageId?: number;
      languageCode?: string;
    },
  ) {
    if (!body.telegramUserId || !body.text) throw new BadRequestException("нужны telegramUserId и text");
    return this.support.handleInbound({ ...body, telegramUpdateId: body.telegramUpdateId ?? body.updateId });
  }

  @Get("api/admin/support/conversations")
  list(@Query("status") status?: string, @Query("limit") limit?: string) {
    return this.support.listConversations({ status, limit: limit ? Number(limit) : undefined });
  }

  @Get("api/admin/support/conversations/:id")
  get(@Param("id") id: string) {
    return this.support.getConversation(id);
  }

  /** Ответ оператора: пишем сообщение, отдаём его боту, фиксируем результат доставки. */
  @Post("api/admin/support/conversations/:id/reply")
  async reply(@Param("id") id: string, @Body() body: { text: string; operatorUserId?: string }) {
    if (!body.text?.trim()) throw new BadRequestException("пустой текст ответа");

    const message = await this.support.replyFromOperator({
      conversationId: id,
      operatorUserId: body.operatorUserId,
      text: body.text,
    });
    if (message.deduped) return { messageId: message.messageId, deduped: true, delivered: false };

    const sent = await this.bot.notify({ telegramId: message.telegramUserId, text: message.text });
    if (sent.ok) {
      await this.support.markDelivered(message.messageId, sent.messageId);
      return { messageId: message.messageId, deduped: false, delivered: true };
    }

    await this.support.markFailed(message.messageId, sent.detail ?? sent.reason);
    return { messageId: message.messageId, deduped: false, delivered: false, reason: sent.reason };
  }

  @Patch("api/admin/support/conversations/:id")
  async patch(@Param("id") id: string, @Body() body: { status?: string; assigneeUserId?: string | null }) {
    if (body.status !== undefined && !CONVERSATION_STATUSES.includes(body.status as ConversationStatus)) {
      throw new BadRequestException(`статус должен быть одним из: ${CONVERSATION_STATUSES.join(", ")}`);
    }
    if (body.assigneeUserId === undefined && body.status === undefined) {
      throw new BadRequestException("нечего менять: ожидается status или assigneeUserId");
    }

    let row = null;
    if (body.assigneeUserId !== undefined) row = await this.support.assign(id, body.assigneeUserId);
    if (body.status !== undefined) row = await this.support.setStatus(id, body.status as ConversationStatus);
    return row;
  }
}

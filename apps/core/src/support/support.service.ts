import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { schema, type Database } from "@vpn/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

export interface InboundInput {
  telegramUserId: number;
  username?: string | null;
  text: string;
  telegramUpdateId?: number | null;
  telegramMessageId?: number | null;
  languageCode?: string | null;
}

export interface OperatorReplyInput {
  conversationId: string;
  operatorUserId?: string | null;
  text: string;
}

const OPEN_STATUSES = ["open", "pending"] as const;
export const CONVERSATION_STATUSES = ["open", "pending", "resolved", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

@Injectable()
export class SupportService {
  private readonly log = new Logger(SupportService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Входящее из Telegram. Три барьера идемпотентности, все на индексах БД:
   *   support_contact_uq  — контакт один на (org, telegram_user_id);
   *   conversation_open_uq — незакрытый диалог у контакта один (partial unique);
   *   message_tg_update_uq — повторная доставка апдейта Telegram не задваивает сообщение.
   * Порядок важен: дедуп апдейта проверяется до диалога, иначе повтор плодит пустые диалоги.
   */
  async handleInbound(input: InboundInput) {
    const contact = await this.upsertContact(input);

    // Дедуп ДО работы с диалогом: повторная доставка апдейта на закрытом диалоге
    // иначе открывала новый — пустой, без единого сообщения.
    if (input.telegramUpdateId != null) {
      const [seen] = await this.db
        .select({ id: schema.message.id, conversationId: schema.message.conversationId })
        .from(schema.message)
        .where(
          and(
            eq(schema.message.orgId, this.cfg.defaultOrgId),
            eq(schema.message.telegramUpdateId, input.telegramUpdateId),
          ),
        )
        .limit(1);
      if (seen) return { deduped: true as const, conversationId: seen.conversationId, contactId: contact.id };
    }

    const conversation = await this.openConversation(contact.id);

    const inserted = await this.db
      .insert(schema.message)
      .values({
        orgId: this.cfg.defaultOrgId,
        conversationId: conversation.id,
        senderType: "contact",
        direction: "in",
        content: input.text,
        telegramMessageId: input.telegramMessageId ?? undefined,
        telegramUpdateId: input.telegramUpdateId ?? undefined,
        deliveryStatus: "sent",
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) {
      // гонка: тот же update_id записал параллельный запрос, диалог у него тот же
      return { deduped: true as const, conversationId: conversation.id, contactId: contact.id };
    }

    await this.db
      .update(schema.conversation)
      .set({ lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.conversation.id, conversation.id));

    return {
      deduped: false as const,
      conversationId: conversation.id,
      contactId: contact.id,
      messageId: inserted[0].id,
    };
  }

  /** Ответ оператора. Возвращает всё нужное для доставки в Telegram. */
  async replyFromOperator(input: OperatorReplyInput) {
    const conversation = await this.getRow(input.conversationId);
    const [contact] = await this.db
      .select()
      .from(schema.supportContact)
      .where(eq(schema.supportContact.id, conversation.contactId))
      .limit(1);
    if (!contact) throw new NotFoundException(`контакт диалога ${input.conversationId} не найден`);

    const dedupKey = this.operatorDedupKey(input.conversationId, input.text);
    const inserted = await this.db
      .insert(schema.message)
      .values({
        orgId: this.cfg.defaultOrgId,
        conversationId: conversation.id,
        senderType: "operator",
        senderUserId: input.operatorUserId ?? undefined,
        direction: "out",
        content: input.text,
        dedupKey,
        deliveryStatus: "pending",
      })
      .onConflictDoNothing()
      .returning();

    if (inserted.length === 0) {
      const [existing] = await this.db
        .select()
        .from(schema.message)
        .where(eq(schema.message.dedupKey, dedupKey))
        .limit(1);
      this.log.warn(`conversation ${conversation.id}: повтор ответа оператора, отправка не дублируется`);
      return {
        deduped: true as const,
        messageId: existing?.id ?? "",
        conversationId: conversation.id,
        telegramUserId: contact.telegramUserId,
        text: input.text,
        dedupKey,
      };
    }

    await this.db
      .update(schema.conversation)
      .set({ lastMessageAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.conversation.id, conversation.id));

    return {
      deduped: false as const,
      messageId: inserted[0].id,
      conversationId: conversation.id,
      telegramUserId: contact.telegramUserId,
      text: input.text,
      dedupKey,
    };
  }

  async markDelivered(messageId: string, telegramMessageId?: number | null) {
    await this.db
      .update(schema.message)
      .set({ deliveryStatus: "sent", telegramMessageId: telegramMessageId ?? undefined, error: null })
      .where(and(eq(schema.message.orgId, this.cfg.defaultOrgId), eq(schema.message.id, messageId)));
  }

  async markFailed(messageId: string, error: string) {
    await this.db
      .update(schema.message)
      .set({ deliveryStatus: "failed", error })
      .where(and(eq(schema.message.orgId, this.cfg.defaultOrgId), eq(schema.message.id, messageId)));
  }

  async listConversations(params: { status?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const filters = [eq(schema.conversation.orgId, this.cfg.defaultOrgId)];
    if (params.status) filters.push(eq(schema.conversation.status, params.status));

    const rows = await this.db
      .select({ conversation: schema.conversation, contact: schema.supportContact })
      .from(schema.conversation)
      .leftJoin(schema.supportContact, eq(schema.conversation.contactId, schema.supportContact.id))
      .where(and(...filters))
      .orderBy(desc(schema.conversation.lastMessageAt), desc(schema.conversation.createdAt))
      .limit(limit);

    return rows.map(({ conversation, contact }) => ({
      id: conversation.id,
      status: conversation.status,
      priority: conversation.priority,
      assigneeUserId: conversation.assigneeUserId,
      tags: conversation.tags,
      lastMessageAt: conversation.lastMessageAt,
      createdAt: conversation.createdAt,
      contact: contact
        ? { id: contact.id, telegramUserId: contact.telegramUserId, username: contact.username }
        : null,
    }));
  }

  async getConversation(id: string) {
    const conversation = await this.getRow(id);
    const [contact] = await this.db
      .select()
      .from(schema.supportContact)
      .where(eq(schema.supportContact.id, conversation.contactId))
      .limit(1);

    const messages = await this.db
      .select()
      .from(schema.message)
      .where(and(eq(schema.message.orgId, this.cfg.defaultOrgId), eq(schema.message.conversationId, id)))
      .orderBy(asc(schema.message.createdAt));

    return {
      ...conversation,
      contact: contact ?? null,
      messages: messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        senderType: m.senderType,
        senderUserId: m.senderUserId,
        content: m.content,
        deliveryStatus: m.deliveryStatus,
        error: m.error,
        createdAt: m.createdAt,
      })),
    };
  }

  async assign(conversationId: string, userId: string | null) {
    const [row] = await this.db
      .update(schema.conversation)
      .set({ assigneeUserId: userId, updatedAt: new Date() })
      .where(
        and(eq(schema.conversation.orgId, this.cfg.defaultOrgId), eq(schema.conversation.id, conversationId)),
      )
      .returning();
    if (!row) throw new NotFoundException(`диалог ${conversationId} не найден`);
    return row;
  }

  async setStatus(conversationId: string, status: ConversationStatus) {
    const resolved = status === "resolved" || status === "closed";
    let rows: (typeof schema.conversation.$inferSelect)[];
    try {
      rows = await this.db
        .update(schema.conversation)
        .set({ status, resolvedAt: resolved ? new Date() : null, updatedAt: new Date() })
        .where(
          and(eq(schema.conversation.orgId, this.cfg.defaultOrgId), eq(schema.conversation.id, conversationId)),
        )
        .returning();
    } catch (err) {
      // переоткрытие диалога, когда у контакта уже есть незакрытый — conversation_open_uq
      if (isUniqueViolation(err)) {
        throw new ConflictException("у контакта уже есть незакрытый диалог");
      }
      throw err;
    }
    const row = rows[0];
    if (!row) throw new NotFoundException(`диалог ${conversationId} не найден`);
    return row;
  }

  private async upsertContact(input: InboundInput) {
    const [contact] = await this.db
      .insert(schema.supportContact)
      .values({
        orgId: this.cfg.defaultOrgId,
        telegramUserId: input.telegramUserId,
        username: input.username ?? undefined,
        languageCode: input.languageCode ?? undefined,
      })
      .onConflictDoUpdate({
        target: [schema.supportContact.orgId, schema.supportContact.telegramUserId],
        set: {
          username: sql`coalesce(excluded.username, ${schema.supportContact.username})`,
          languageCode: sql`coalesce(excluded.language_code, ${schema.supportContact.languageCode})`,
        },
      })
      .returning();
    return contact;
  }

  /** Открытый диалог берём, иначе создаём; гонку двух апдейтов ловит conversation_open_uq. */
  private async openConversation(contactId: string) {
    const existing = await this.findOpen(contactId);
    if (existing) return existing;

    const inserted = await this.db
      .insert(schema.conversation)
      .values({ orgId: this.cfg.defaultOrgId, contactId, lastMessageAt: new Date() })
      .onConflictDoNothing()
      .returning();
    if (inserted.length > 0) return inserted[0];

    const raced = await this.findOpen(contactId);
    if (!raced) throw new NotFoundException(`не удалось открыть диалог контакта ${contactId}`);
    return raced;
  }

  private async findOpen(contactId: string) {
    const rows = await this.db
      .select()
      .from(schema.conversation)
      .where(
        and(
          eq(schema.conversation.orgId, this.cfg.defaultOrgId),
          eq(schema.conversation.contactId, contactId),
          inArray(schema.conversation.status, [...OPEN_STATUSES]),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async getRow(conversationId: string) {
    const rows = await this.db
      .select()
      .from(schema.conversation)
      .where(
        and(eq(schema.conversation.orgId, this.cfg.defaultOrgId), eq(schema.conversation.id, conversationId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException(`диалог ${conversationId} не найден`);
    return row;
  }

  /**
   * Ключ детерминирован в пределах минуты: двойной клик «Отправить» с тем же текстом
   * даёт один и тот же ключ и не задваивает сообщение, а осознанный повтор позже — новое.
   */
  private operatorDedupKey(conversationId: string, text: string): string {
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const hash = createHash("sha256").update(`${text}|${minuteBucket}`).digest("hex").slice(0, 16);
    return `op:${conversationId}:${hash}`;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

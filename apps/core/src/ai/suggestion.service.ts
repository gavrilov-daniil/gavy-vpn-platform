import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gt, inArray } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { getAiAdapter } from "./adapters/registry.js";
import { AiProviderService } from "./ai-provider.service.js";
import { KbService } from "./kb.service.js";
import { SUGGESTION_SYSTEM_PROMPT, buildSuggestionPrompt } from "./suggestion.prompt.js";

/** Сколько последних сообщений диалога вообще рассматриваем (дальше режет лимит символов). */
const HISTORY_DEPTH = 20;
/** Сколько документов базы знаний уходит в промпт. */
const DOCUMENT_LIMIT = 4;
const REQUEST_TIMEOUT_MS = 60_000;

export const SUGGESTION_STATUSES = ["proposed", "accepted", "edited", "rejected", "sent"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export type SuggestionOutcome =
  | { status: "created"; suggestionId: string }
  | { status: "exists"; suggestionId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Подсказки операторам.
 *
 * Жёсткое требование: ИИ никогда не пишет клиенту сам. Здесь только создаётся строка
 * ai_suggestion со статусом proposed; отправка идёт существующим путём ответа оператора
 * (SupportService.replyFromOperator), который в конце переводит подсказку в sent.
 *
 * Барьеров от повторной генерации два, оба на индексах БД:
 *   job_dedup(key)               — claim ДО вызова модели: параллельный воркер не платит второй раз;
 *   ai_suggestion_idempotency_uq — последний рубеж на гонке двух вставок.
 * Ключ детерминирован — ai:<conversationId>:<messageId>.
 */
@Injectable()
export class SuggestionService {
  private readonly log = new Logger(SuggestionService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly providers: AiProviderService,
    private readonly kb: KbService,
  ) {}

  /**
   * Диалоги, где последнее слово за клиентом и подсказки на это сообщение ещё нет.
   * Окно нужно, чтобы джоба не пыталась вечно догенерировать подсказку к сообщению,
   * на котором провайдер упал (claim не снимается — иначе получим бесконечный ретрай).
   */
  async findPending(lookbackMs: number, limit: number): Promise<Array<{ conversationId: string; messageId: string }>> {
    const since = new Date(Date.now() - lookbackMs);
    const rows = await this.db
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(
        and(
          eq(schema.conversation.orgId, this.cfg.defaultOrgId),
          inArray(schema.conversation.status, ["open", "pending"]),
          gt(schema.conversation.lastMessageAt, since),
        ),
      )
      .orderBy(desc(schema.conversation.lastMessageAt))
      .limit(limit);

    const pending: Array<{ conversationId: string; messageId: string }> = [];
    for (const row of rows) {
      const message = await this.lastContactMessage(row.id);
      if (!message) continue;
      const existing = await this.byIdempotencyKey(this.idempotencyKey(row.id, message.id));
      if (existing) continue;
      pending.push({ conversationId: row.id, messageId: message.id });
    }
    return pending;
  }

  /**
   * Генерация подсказки на последнее сообщение клиента.
   * Не бросает наружу ошибку провайдера: обращение уже принято, и лежащая модель
   * не имеет права ломать работу оператора — он просто работает без подсказки.
   *
   * `force` — кнопка «Сгенерировать» в админке. Она НЕ создаёт вторую подсказку
   * на то же сообщение: если строка уже есть, вернём её. Force снимает только claim,
   * то есть даёт повторить попытку после сбоя провайдера.
   */
  async generate(input: { conversationId: string; force?: boolean }): Promise<SuggestionOutcome> {
    const message = await this.lastContactMessage(input.conversationId);
    if (!message) return { status: "skipped", reason: "в диалоге нет сообщений клиента" };

    const key = this.idempotencyKey(input.conversationId, message.id);
    const existing = await this.byIdempotencyKey(key);
    if (existing) return { status: "exists", suggestionId: existing.id };

    const provider = await this.providers.getActive();
    if (!provider) return { status: "skipped", reason: "провайдер ИИ не подключён" };
    const limits = this.providers.limitsOf(provider);

    const perConversation = await this.countSuggestions(eq(schema.aiSuggestion.conversationId, input.conversationId));
    if (perConversation >= limits.maxPerConversation) {
      return { status: "skipped", reason: `исчерпан лимит подсказок на диалог (${limits.maxPerConversation})` };
    }
    const perDay = await this.countSuggestions(gt(schema.aiSuggestion.createdAt, new Date(Date.now() - 86_400_000)));
    if (perDay >= limits.maxPerDay) {
      return { status: "skipped", reason: `исчерпан суточный лимит подсказок (${limits.maxPerDay})` };
    }

    if (!(await this.claim(key, input.force ?? false))) {
      return { status: "skipped", reason: "подсказка уже генерируется или уже пробовали" };
    }

    try {
      const [history, secrets] = await Promise.all([
        this.history(input.conversationId),
        this.subscriberSecrets(input.conversationId),
      ]);
      const documents = await this.kb.search(message.content, DOCUMENT_LIMIT);
      const { prompt, documentIds } = buildSuggestionPrompt({
        messages: history,
        documents,
        maxContextChars: limits.maxContextChars,
        secrets,
      });

      const completion = await getAiAdapter(provider.provider).complete(provider, {
        system: SUGGESTION_SYSTEM_PROMPT,
        prompt,
        maxTokens: limits.maxOutputTokens,
        timeoutMs: REQUEST_TIMEOUT_MS,
        correlationId: `ai-suggest:${input.conversationId}`,
      });

      const inserted = await this.db
        .insert(schema.aiSuggestion)
        .values({
          orgId: this.cfg.defaultOrgId,
          conversationId: input.conversationId,
          messageId: message.id,
          model: completion.model,
          content: completion.text,
          retrievedDocIds: documentIds,
          status: "proposed",
          idempotencyKey: key,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted.length === 0) {
        // гонка: параллельная генерация успела вставить строку с тем же ключом
        const raced = await this.byIdempotencyKey(key);
        return raced ? { status: "exists", suggestionId: raced.id } : { status: "failed", reason: "конфликт вставки" };
      }

      this.log.log(
        `ai.suggestion.created conversation=${input.conversationId} model=${completion.model} docs=${documentIds.length}`,
      );
      return { status: "created", suggestionId: inserted[0].id };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // claim НЕ снимаем: провайдер лежит — повтор через минуту только добьёт его
      // и потратит деньги. Оператор при необходимости жмёт «Сгенерировать».
      this.log.warn(`ai.suggestion.failed conversation=${input.conversationId}: ${reason}`);
      return { status: "failed", reason };
    }
  }

  async listForConversation(conversationId: string) {
    const rows = await this.db
      .select()
      .from(schema.aiSuggestion)
      .where(
        and(
          eq(schema.aiSuggestion.orgId, this.cfg.defaultOrgId),
          eq(schema.aiSuggestion.conversationId, conversationId),
        ),
      )
      .orderBy(desc(schema.aiSuggestion.createdAt));

    const titles = await this.kb.titlesOf([...new Set(rows.flatMap((r) => r.retrievedDocIds))]);
    const titleById = new Map(titles.map((t) => [t.id, t.title]));

    return rows.map((row) => ({
      id: row.id,
      messageId: row.messageId,
      model: row.model,
      content: row.content,
      status: row.status,
      createdAt: row.createdAt,
      documents: row.retrievedDocIds.map((id) => ({ id, title: titleById.get(id) ?? "документ удалён" })),
    }));
  }

  /**
   * Оператор принял подсказку. Если он её поправил — статус edited, и это единственный
   * след того, что текст менялся: content остаётся исходным ответом модели, иначе
   * сравнивать качество будет не с чем.
   */
  async accept(suggestionId: string, editedText?: string) {
    const row = await this.getRow(suggestionId);
    if (row.status === "sent") throw new BadRequestException("подсказка уже отправлена");
    const edited = typeof editedText === "string" && editedText.trim() !== "" && editedText.trim() !== row.content.trim();
    return this.setStatus(suggestionId, edited ? "edited" : "accepted");
  }

  async reject(suggestionId: string) {
    const row = await this.getRow(suggestionId);
    if (row.status === "sent") throw new BadRequestException("подсказка уже отправлена");
    return this.setStatus(suggestionId, "rejected");
  }

  /** Вызывается из пути ответа оператора после успешной доставки в Telegram. */
  async markSent(suggestionId: string) {
    return this.setStatus(suggestionId, "sent");
  }

  private async setStatus(suggestionId: string, status: SuggestionStatus) {
    const [row] = await this.db
      .update(schema.aiSuggestion)
      .set({ status })
      .where(and(eq(schema.aiSuggestion.orgId, this.cfg.defaultOrgId), eq(schema.aiSuggestion.id, suggestionId)))
      .returning();
    if (!row) throw new NotFoundException(`подсказка ${suggestionId} не найдена`);
    return row;
  }

  private async getRow(suggestionId: string) {
    const rows = await this.db
      .select()
      .from(schema.aiSuggestion)
      .where(and(eq(schema.aiSuggestion.orgId, this.cfg.defaultOrgId), eq(schema.aiSuggestion.id, suggestionId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException(`подсказка ${suggestionId} не найдена`);
    return row;
  }

  private idempotencyKey(conversationId: string, messageId: string): string {
    return `ai:${conversationId}:${messageId}`;
  }

  private async byIdempotencyKey(key: string) {
    const rows = await this.db
      .select()
      .from(schema.aiSuggestion)
      .where(eq(schema.aiSuggestion.idempotencyKey, key))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Claim до вызова модели. Барьер — первичный ключ job_dedup, а не проверка в коде. */
  private async claim(key: string, force: boolean): Promise<boolean> {
    const dedupKey = `ai_suggest:${key}`;
    if (force) await this.db.delete(schema.jobDedup).where(eq(schema.jobDedup.key, dedupKey));

    const claimed = await this.db
      .insert(schema.jobDedup)
      .values({ key: dedupKey, orgId: this.cfg.defaultOrgId, kind: "ai_suggest" })
      .onConflictDoNothing()
      .returning();
    return claimed.length > 0;
  }

  private async countSuggestions(filter: ReturnType<typeof eq>) {
    const [row] = await this.db
      .select({ n: count() })
      .from(schema.aiSuggestion)
      .where(and(eq(schema.aiSuggestion.orgId, this.cfg.defaultOrgId), filter));
    return Number(row?.n ?? 0);
  }

  private async lastContactMessage(conversationId: string) {
    const rows = await this.db
      .select()
      .from(schema.message)
      .where(
        and(
          eq(schema.message.orgId, this.cfg.defaultOrgId),
          eq(schema.message.conversationId, conversationId),
          eq(schema.message.senderType, "contact"),
        ),
      )
      .orderBy(desc(schema.message.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  private async history(conversationId: string) {
    const rows = await this.db
      .select({ senderType: schema.message.senderType, content: schema.message.content })
      .from(schema.message)
      .where(and(eq(schema.message.orgId, this.cfg.defaultOrgId), eq(schema.message.conversationId, conversationId)))
      .orderBy(desc(schema.message.createdAt))
      .limit(HISTORY_DEPTH);
    return rows.reverse();
  }

  /**
   * Секреты подписки клиента — их вырезает redactSecrets. Общие шаблоны ловят форму
   * (uuid, длинный hex), а этот список ловит конкретные значения, даже если клиент
   * прислал их в изуродованном виде.
   */
  private async subscriberSecrets(conversationId: string): Promise<string[]> {
    const rows = await this.db
      .select({ shortUuid: schema.subscription.shortUuid, vlessUuid: schema.subscription.vlessUuid })
      .from(schema.conversation)
      .innerJoin(schema.supportContact, eq(schema.conversation.contactId, schema.supportContact.id))
      .innerJoin(schema.subscription, eq(schema.supportContact.subscriberId, schema.subscription.subscriberId))
      .where(eq(schema.conversation.id, conversationId));

    const secrets: string[] = [];
    for (const row of rows) {
      if (row.shortUuid) secrets.push(row.shortUuid, `${this.cfg.subPublicHost}/auto/${row.shortUuid}`);
      if (row.vlessUuid) secrets.push(row.vlessUuid);
    }
    return secrets;
  }
}

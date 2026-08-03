import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

export interface KbHit {
  id: string;
  title: string;
  body: string;
}

/** Длиннее — уже не запрос, а пересказ переписки: to_tsquery от него бесполезен. */
const MAX_QUERY_CHARS = 500;

/**
 * База знаний и поиск по ней.
 *
 * Поиск — обычный полнотекстовый Postgres по индексу kb_document_fts_idx. Эмбеддинги
 * и pgvector сюда не идут осознанно: база поддержки — десятки документов, а расширение
 * плюс модель эмбеддингов означают внешнюю зависимость в горячем пути ради того,
 * что решается одним GIN-индексом.
 */
@Injectable()
export class KbService {
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  async list(includeInactive = true) {
    const filters = [eq(schema.kbDocument.orgId, this.cfg.defaultOrgId)];
    if (!includeInactive) filters.push(eq(schema.kbDocument.isActive, true));
    return this.db
      .select()
      .from(schema.kbDocument)
      .where(and(...filters))
      .orderBy(desc(schema.kbDocument.updatedAt));
  }

  async create(input: { title: string; body: string; source?: string | null; lang?: string }) {
    const [row] = await this.db
      .insert(schema.kbDocument)
      .values({
        orgId: this.cfg.defaultOrgId,
        title: input.title.trim(),
        body: input.body,
        source: input.source ?? undefined,
        lang: input.lang ?? "ru",
      })
      .returning();
    return row;
  }

  async update(
    id: string,
    patch: { title?: string; body?: string; source?: string | null; lang?: string; isActive?: boolean },
  ) {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) values.title = patch.title.trim();
    if (patch.body !== undefined) values.body = patch.body;
    if (patch.source !== undefined) values.source = patch.source;
    if (patch.lang !== undefined) values.lang = patch.lang;
    if (patch.isActive !== undefined) values.isActive = patch.isActive;

    const [row] = await this.db
      .update(schema.kbDocument)
      .set(values)
      .where(and(eq(schema.kbDocument.orgId, this.cfg.defaultOrgId), eq(schema.kbDocument.id, id)))
      .returning();
    if (!row) throw new NotFoundException(`документ ${id} не найден`);
    return row;
  }

  /**
   * Отбор документов под вопрос клиента. Выключенный документ не участвует —
   * это и есть способ убрать устаревший текст, не удаляя строку: на неё уже
   * могут ссылаться retrieved_doc_ids прошлых подсказок.
   */
  async search(query: string, limit = 4): Promise<KbHit[]> {
    const text = query.trim().slice(0, MAX_QUERY_CHARS);
    if (!text) return [];

    // plainto_tsquery склеивает слова через AND: вопрос клиента «как оформить возврат
    // средств» не нашёл бы документ про возврат из-за одного лишнего слова. Меняем
    // операторы на OR уже в разобранном запросе — стемминг и стоп-слова остаются
    // за Postgres, а порядок выдачи задаёт ts_rank, а не число совпавших слов.
    const rows = (await this.db.execute(sql`
      with q as (select replace(plainto_tsquery('russian', ${text})::text, '&', '|')::tsquery as tsq)
      select d.id, d.title, d.body
      from kb_document d, q
      where d.org_id = ${this.cfg.defaultOrgId}
        and d.is_active
        and to_tsvector('russian', d.title || ' ' || d.body) @@ q.tsq
      order by ts_rank(to_tsvector('russian', d.title || ' ' || d.body), q.tsq) desc
      limit ${limit}
    `)) as unknown as KbHit[];

    return rows.map((row) => ({ id: row.id, title: row.title, body: row.body }));
  }

  /** Названия документов подсказки — оператор должен видеть, на чём она основана. */
  async titlesOf(ids: string[]): Promise<Array<{ id: string; title: string }>> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ id: schema.kbDocument.id, title: schema.kbDocument.title })
      .from(schema.kbDocument)
      .where(and(eq(schema.kbDocument.orgId, this.cfg.defaultOrgId), inArray(schema.kbDocument.id, ids)));
    return rows;
  }
}

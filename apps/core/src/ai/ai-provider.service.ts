import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { decryptCredentials, encryptCredentials, maskCredentialsForDisplay } from "@corelink/core-kit";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { getAiAdapter } from "./adapters/registry.js";
import { isAllowedAiApiUrl } from "./provider-urls.js";
import type { AiProviderConfig } from "./adapters/types.js";

/** Потолки расхода. Живут в настройках провайдера — их правит оператор, не деплой. */
export interface AiLimits {
  /** Сколько символов переписки и документов уходит в промпт. */
  maxContextChars: number;
  maxOutputTokens: number;
  /** Потолок подсказок на один диалог: зациклившийся диалог не должен доить модель. */
  maxPerConversation: number;
  /** Потолок на организацию за сутки — последний рубеж по деньгам. */
  maxPerDay: number;
}

const DEFAULT_LIMITS: AiLimits = {
  maxContextChars: 12_000,
  maxOutputTokens: 700,
  maxPerConversation: 20,
  maxPerDay: 300,
};

/**
 * Провайдеры ИИ живут в БД и управляются админкой — тот же паттерн, что у мерчантов.
 * Ключ шифруется при записи и расшифровывается только в момент вызова провайдера;
 * наружу отдаётся маскированным. В env ключей нет: смена ключа не требует выкатки.
 */
@Injectable()
export class AiProviderService {
  private readonly log = new Logger(AiProviderService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  async list() {
    return this.db
      .select()
      .from(schema.aiProvider)
      .where(eq(schema.aiProvider.orgId, this.cfg.defaultOrgId))
      .orderBy(asc(schema.aiProvider.alias));
  }

  /** Для админки: ключи наружу не отдаём, только факт их наличия. */
  async listForAdmin() {
    const rows = await this.list();
    return rows.map((row) => this.forAdmin(row));
  }

  /** Наружу уходит и из create/update тоже: иначе ответ на запись отдавал бы шифртекст. */
  private forAdmin(row: typeof schema.aiProvider.$inferSelect) {
    return {
      ...row,
      credentials: maskCredentialsForDisplay(row.credentials),
      isConfigured: this.isConfigured(row),
    };
  }

  /**
   * Провайдер для генерации: включённый и настроенный, первый по алиасу.
   * Второй включённый — это осознанный запасной аккаунт, а не ошибка, поэтому
   * выбор детерминирован сортировкой, а не порядком строк в таблице.
   */
  async getActive(): Promise<AiProviderConfig | null> {
    const rows = await this.list();
    const row = rows.find((r) => r.isEnabled && this.isConfigured(r));
    return row ? this.toConfig(row) : null;
  }

  limitsOf(config: AiProviderConfig): AiLimits {
    return {
      maxContextChars: positiveSetting(config.settings.max_context_chars, DEFAULT_LIMITS.maxContextChars),
      maxOutputTokens: positiveSetting(config.settings.max_output_tokens, DEFAULT_LIMITS.maxOutputTokens),
      maxPerConversation: positiveSetting(config.settings.max_per_conversation, DEFAULT_LIMITS.maxPerConversation),
      maxPerDay: positiveSetting(config.settings.max_per_day, DEFAULT_LIMITS.maxPerDay),
    };
  }

  async create(input: {
    provider: string;
    alias: string;
    model?: string;
    credentials?: Record<string, string>;
    settings?: Record<string, unknown>;
  }) {
    const adapter = getAiAdapter(input.provider); // валидация провайдера
    const [row] = await this.db
      .insert(schema.aiProvider)
      .values({
        orgId: this.cfg.defaultOrgId,
        provider: input.provider,
        alias: input.alias,
        model: input.model?.trim() || adapter.defaultModel,
        credentials: encryptCredentials(input.credentials ?? {}, this.cfg.secretsMasterKey),
        settings: this.sanitizeSettings(input.provider, input.settings ?? {}, input.alias),
      })
      .returning();
    return this.forAdmin(row);
  }

  async update(
    providerId: string,
    patch: {
      alias?: string;
      model?: string;
      isEnabled?: boolean;
      settings?: Record<string, unknown>;
      /** Передаются только изменяемые ключи; пустая строка = удалить ключ. */
      credentials?: Record<string, string>;
    },
  ) {
    const current = await this.getRow(providerId);
    const values: Record<string, unknown> = { updatedAt: new Date() };

    if (patch.alias !== undefined) values.alias = patch.alias;
    if (patch.model !== undefined && patch.model.trim() !== "") values.model = patch.model.trim();
    if (patch.isEnabled !== undefined) values.isEnabled = patch.isEnabled;
    if (patch.settings !== undefined) {
      values.settings = this.sanitizeSettings(
        current.provider,
        { ...current.settings, ...patch.settings },
        providerId,
      );
    }
    if (patch.credentials) {
      const merged = { ...current.credentials };
      for (const [k, v] of Object.entries(patch.credentials)) {
        if (v === "") delete merged[k];
        else merged[k] = v;
      }
      values.credentials = encryptCredentials(merged, this.cfg.secretsMasterKey);
    }

    const [row] = await this.db
      .update(schema.aiProvider)
      .set(values)
      .where(and(eq(schema.aiProvider.orgId, this.cfg.defaultOrgId), eq(schema.aiProvider.id, providerId)))
      .returning();
    return this.forAdmin(row);
  }

  /** Кнопка «Проверить» в админке — дёргает провайдера и сохраняет результат. */
  async healthCheck(providerId: string) {
    const row = await this.getRow(providerId);
    const adapter = getAiAdapter(row.provider);
    const result = adapter.isConfigured(this.toConfig(row))
      ? await adapter.healthCheck(this.toConfig(row))
      : { ok: false, detail: "не задан ключ" };

    await this.db
      .update(schema.aiProvider)
      .set({ lastCheckAt: new Date(), lastCheckOk: result.ok, lastCheckError: result.ok ? null : result.detail })
      .where(eq(schema.aiProvider.id, providerId));
    return result;
  }

  isConfigured(row: typeof schema.aiProvider.$inferSelect): boolean {
    return getAiAdapter(row.provider).isConfigured(this.toConfig(row));
  }

  /**
   * Адрес API приходит из тела PATCH-а, а адаптер пойдёт по нему с расшифрованным
   * ключом. Разрешённое отбрасываем не молча — оператор должен увидеть в логе,
   * почему его прокси не подхватился.
   */
  private sanitizeSettings(
    provider: string,
    settings: Record<string, unknown>,
    ref: string,
  ): Record<string, unknown> {
    if (!("api_url" in settings)) return settings;
    if (settings.api_url === "" || settings.api_url === null) {
      const { api_url: _cleared, ...rest } = settings;
      return rest;
    }
    if (isAllowedAiApiUrl(provider, settings.api_url)) return settings;

    const { api_url: rejected, ...rest } = settings;
    this.log.warn(`ai provider ${ref} (${provider}): адрес ${String(rejected)} не принят, настройка отброшена`);
    return rest;
  }

  private async getRow(providerId: string) {
    const rows = await this.db
      .select()
      .from(schema.aiProvider)
      .where(and(eq(schema.aiProvider.orgId, this.cfg.defaultOrgId), eq(schema.aiProvider.id, providerId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException(`провайдер ИИ ${providerId} не найден`);
    return row;
  }

  private toConfig(row: typeof schema.aiProvider.$inferSelect): AiProviderConfig {
    return {
      id: row.id,
      provider: row.provider as AiProviderConfig["provider"],
      alias: row.alias,
      model: row.model,
      credentials: decryptCredentials(row.credentials, this.cfg.secretsMasterKey),
      settings: row.settings,
    };
  }
}

/**
 * Ноль и мусор уходят в дефолт: нулевой лимит выключил бы подсказки насовсем,
 * а NaN в сравнении всегда ложен — лимит молча перестал бы действовать.
 */
function positiveSetting(raw: unknown, fallback: number): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

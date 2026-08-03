import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { decryptCredentials, encryptCredentials, maskCredentialsForDisplay } from "@corelink/core-kit";
import { getAdapter, isAllowedProviderApiUrl, type MerchantConfig } from "@corelink/payments";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

/**
 * Мерчанты живут в БД и управляются админкой: включение/выключение, ключи,
 * test/live, несколько аккаунтов одного провайдера. Рестарт не нужен.
 * Креды шифруются при записи и расшифровываются только в момент вызова провайдера.
 */
@Injectable()
export class MerchantService {
  private readonly log = new Logger(MerchantService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  async list() {
    return this.db
      .select()
      .from(schema.paymentMerchant)
      .where(eq(schema.paymentMerchant.orgId, this.cfg.defaultOrgId))
      .orderBy(schema.paymentMerchant.priority);
  }

  /** Для админки: креды наружу не отдаём, только факт их наличия. */
  async listForAdmin() {
    const rows = await this.list();
    return rows.map((m) => ({
      ...m,
      credentials: maskCredentialsForDisplay(m.credentials),
      isConfigured: this.isConfigured(m),
    }));
  }

  /** Доступные пользователю способы оплаты: включён, настроен, поддерживает назначение. */
  async listAvailable(purpose: "topup" | "plan" | "gift") {
    const rows = await this.list();
    return rows.filter((m) => {
      if (!m.isEnabled || !this.isConfigured(m)) return false;
      if (!m.purposes.includes(purpose)) return false;
      return getAdapter(m.provider).supportedPurposes.includes(purpose);
    });
  }

  async getConfig(merchantId: string): Promise<MerchantConfig> {
    const rows = await this.db
      .select()
      .from(schema.paymentMerchant)
      .where(and(eq(schema.paymentMerchant.orgId, this.cfg.defaultOrgId), eq(schema.paymentMerchant.id, merchantId)))
      .limit(1);
    const m = rows[0];
    if (!m) throw new NotFoundException(`мерчант ${merchantId} не найден`);
    return this.toConfig(m);
  }

  /** Ищем мерчанта, которому адресован вебхук: по провайдеру среди включённых. */
  async findByProvider(provider: string): Promise<MerchantConfig[]> {
    const rows = await this.db
      .select()
      .from(schema.paymentMerchant)
      .where(and(eq(schema.paymentMerchant.orgId, this.cfg.defaultOrgId), eq(schema.paymentMerchant.provider, provider)))
      .orderBy(schema.paymentMerchant.priority);
    return rows.filter((m) => m.isEnabled).map((m) => this.toConfig(m));
  }

  async create(input: {
    provider: string;
    alias: string;
    credentials?: Record<string, string>;
    settings?: Record<string, unknown>;
    purposes?: string[];
    title?: string;
    mode?: "live" | "test";
  }) {
    getAdapter(input.provider); // валидация провайдера
    const [row] = await this.db
      .insert(schema.paymentMerchant)
      .values({
        orgId: this.cfg.defaultOrgId,
        provider: input.provider,
        alias: input.alias,
        title: input.title,
        mode: input.mode ?? "live",
        credentials: encryptCredentials(input.credentials ?? {}, this.cfg.secretsMasterKey),
        settings: this.sanitizeSettings(input.provider, input.settings ?? {}, input.alias),
        purposes: input.purposes ?? ["topup", "plan"],
      })
      .returning();
    return row;
  }

  async update(
    merchantId: string,
    patch: {
      alias?: string;
      title?: string;
      isEnabled?: boolean;
      mode?: "live" | "test";
      priority?: number;
      purposes?: string[];
      settings?: Record<string, unknown>;
      /** Передаются только изменяемые ключи; пустая строка = удалить ключ. */
      credentials?: Record<string, string>;
    },
  ) {
    const current = await this.getRow(merchantId);
    const values: Record<string, unknown> = { updatedAt: new Date() };

    if (patch.alias !== undefined) values.alias = patch.alias;
    if (patch.title !== undefined) values.title = patch.title;
    if (patch.isEnabled !== undefined) values.isEnabled = patch.isEnabled;
    if (patch.mode !== undefined) values.mode = patch.mode;
    if (patch.priority !== undefined) values.priority = patch.priority;
    if (patch.purposes !== undefined) values.purposes = patch.purposes;
    if (patch.settings !== undefined) {
      values.settings = this.sanitizeSettings(
        current.provider,
        { ...current.settings, ...patch.settings },
        merchantId,
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
      .update(schema.paymentMerchant)
      .set(values)
      .where(and(eq(schema.paymentMerchant.orgId, this.cfg.defaultOrgId), eq(schema.paymentMerchant.id, merchantId)))
      .returning();
    return row;
  }

  /** Кнопка «Проверить» в админке — дёргает провайдера и сохраняет результат. */
  async healthCheck(merchantId: string) {
    const config = await this.getConfig(merchantId);
    const adapter = getAdapter(config.provider);
    let result: { ok: boolean; detail?: string };

    if (!adapter.isConfigured(config)) {
      result = { ok: false, detail: "не заданы ключи" };
    } else if (!adapter.healthCheck) {
      result = { ok: true, detail: "провайдер не поддерживает проверку; ключи на месте" };
    } else {
      result = await adapter.healthCheck(config);
    }

    await this.db
      .update(schema.paymentMerchant)
      .set({ lastCheckAt: new Date(), lastCheckOk: result.ok, lastCheckError: result.ok ? null : result.detail })
      .where(eq(schema.paymentMerchant.id, merchantId));
    return result;
  }

  /**
   * Нерасшифровываемые креды — это «не настроен», а не сбой запроса.
   *
   * `toConfig` расшифровывает креды и падает при сменённом `SECRETS_MASTER_KEY` или битой
   * строке в БД. Без этого перехвата один такой мерчант ронял 500 и список целиком: экран
   * мерчантов умирал ровно в тот момент, когда через него нужно заново ввести ключи, а
   * `listAvailable` перестал бы отдавать боту ЛЮБОЙ способ оплаты, хотя остальные исправны.
   * Сценарий штатный — ротация ключа или дамп, восстановленный со старым (`.env.example`).
   */
  isConfigured(row: typeof schema.paymentMerchant.$inferSelect): boolean {
    try {
      return getAdapter(row.provider).isConfigured(this.toConfig(row));
    } catch (err) {
      this.log.error(
        `merchant ${row.alias} (${row.provider}): креды не читаются — ${err instanceof Error ? err.message : String(err)}. ` +
          `Проверьте SECRETS_MASTER_KEY; до этого мерчант считается ненастроенным`,
      );
      return false;
    }
  }

  /**
   * Настройки приходят из тела PATCH-а. Адрес API среди них опасен: адаптер пойдёт
   * по нему с расшифрованным боевым токеном. Разрешаем только хосты из allowlist
   * провайдера, остальное выбрасываем — адаптер возьмёт константу.
   */
  private sanitizeSettings(
    provider: string,
    settings: Record<string, unknown>,
    merchantRef: string,
  ): Record<string, unknown> {
    if (!("api_url" in settings)) return settings;
    if (isAllowedProviderApiUrl(provider, settings.api_url)) return settings;

    const { api_url: rejected, ...rest } = settings;
    this.log.warn(`merchant ${merchantRef} (${provider}): api_url ${String(rejected)} вне allowlist, настройка отброшена`);
    return rest;
  }

  private async getRow(merchantId: string) {
    const rows = await this.db
      .select()
      .from(schema.paymentMerchant)
      .where(and(eq(schema.paymentMerchant.orgId, this.cfg.defaultOrgId), eq(schema.paymentMerchant.id, merchantId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException(`мерчант ${merchantId} не найден`);
    return row;
  }

  private toConfig(row: typeof schema.paymentMerchant.$inferSelect): MerchantConfig {
    return {
      id: row.id,
      provider: row.provider as MerchantConfig["provider"],
      alias: row.alias,
      mode: row.mode as "live" | "test",
      credentials: decryptCredentials(row.credentials, this.cfg.secretsMasterKey),
      settings: row.settings,
    };
  }
}

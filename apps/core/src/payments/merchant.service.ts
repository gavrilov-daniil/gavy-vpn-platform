import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { decryptCredentials, encryptCredentials, maskCredentialsForDisplay } from "@vpn/core-kit";
import { getAdapter, type MerchantConfig } from "@vpn/payments";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

/**
 * Мерчанты живут в БД и управляются админкой: включение/выключение, ключи,
 * test/live, несколько аккаунтов одного провайдера. Рестарт не нужен.
 * Креды шифруются при записи и расшифровываются только в момент вызова провайдера.
 */
@Injectable()
export class MerchantService {
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
        settings: input.settings ?? {},
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
    if (patch.settings !== undefined) values.settings = { ...current.settings, ...patch.settings };

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

  isConfigured(row: typeof schema.paymentMerchant.$inferSelect): boolean {
    return getAdapter(row.provider).isConfigured(this.toConfig(row));
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

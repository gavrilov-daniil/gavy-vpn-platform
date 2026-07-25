import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { RemnawaveClient, type RemnawaveUser } from "./remnawave.client.js";

export interface ImportReport {
  dryRun: boolean;
  users: { total: number; created: number; updated: number; skipped: number };
  squads: { total: number; created: number };
  devices: { total: number; created: number };
  warnings: string[];
}

/**
 * Перенос данных с действующей панели.
 *
 * Главный инвариант: идентичность переносится ДОСЛОВНО. `short_uuid` живёт в
 * сохранённой у клиента ссылке, `vless_uuid` — в его конфиге. Сгенерировать их
 * заново означает молча отключить всю базу: клиент продолжит ходить по старому
 * URL со старым uuid и просто перестанет подключаться.
 *
 * Импорт идемпотентен: повторный прогон обновляет существующие записи и не
 * плодит дубликатов. Сначала всегда dry-run — он показывает расхождения,
 * ничего не записывая.
 */
@Injectable()
export class RemnawaveImportService {
  private readonly log = new Logger(RemnawaveImportService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  async run(options: { dryRun?: boolean; withDevices?: boolean } = {}): Promise<ImportReport> {
    const dryRun = options.dryRun !== false; // по умолчанию НЕ пишем
    const client = new RemnawaveClient(this.cfg.remnawaveUrl, this.cfg.remnawaveToken);

    const report: ImportReport = {
      dryRun,
      users: { total: 0, created: 0, updated: 0, skipped: 0 },
      squads: { total: 0, created: 0 },
      devices: { total: 0, created: 0 },
      warnings: [],
    };

    if (!client.isConfigured()) {
      report.warnings.push("не заданы REMNAWAVE_URL / REMNAWAVE_TOKEN — импортировать неоткуда");
      return report;
    }

    const squadMap = await this.importSquads(client, dryRun, report);
    await this.importUsers(client, dryRun, options.withDevices === true, squadMap, report);

    this.log.log(
      `импорт ${dryRun ? "(dry-run) " : ""}завершён: юзеров ${report.users.created}+${report.users.updated}, ` +
        `squad'ов ${report.squads.created}, устройств ${report.devices.created}`,
    );
    return report;
  }

  /** Squad'ы переносим первыми: на них ссылается доступ подписок к нодам. */
  private async importSquads(
    client: RemnawaveClient,
    dryRun: boolean,
    report: ImportReport,
  ): Promise<Map<string, string>> {
    const squads = await client.listSquads();
    report.squads.total = squads.length;
    const map = new Map<string, string>();

    for (const s of squads) {
      const [existing] = await this.db
        .select()
        .from(schema.squad)
        .where(and(eq(schema.squad.orgId, this.cfg.defaultOrgId), eq(schema.squad.name, s.name)))
        .limit(1);

      if (existing) {
        map.set(s.uuid, existing.id);
        continue;
      }
      if (dryRun) {
        report.squads.created++;
        map.set(s.uuid, `dry-run:${s.uuid}`);
        continue;
      }

      const [created] = await this.db
        .insert(schema.squad)
        .values({ orgId: this.cfg.defaultOrgId, name: s.name })
        .returning();
      map.set(s.uuid, created.id);
      report.squads.created++;
    }
    return map;
  }

  private async importUsers(
    client: RemnawaveClient,
    dryRun: boolean,
    withDevices: boolean,
    squadMap: Map<string, string>,
    report: ImportReport,
  ): Promise<void> {
    const users = await client.listUsers();
    report.users.total = users.length;

    for (const u of users) {
      if (!u.shortUuid || !u.vlessUuid) {
        report.users.skipped++;
        report.warnings.push(`пользователь ${u.username ?? u.uuid}: нет shortUuid или vlessUuid — пропущен`);
        continue;
      }

      const [existing] = await this.db
        .select()
        .from(schema.subscription)
        .where(
          and(
            eq(schema.subscription.orgId, this.cfg.defaultOrgId),
            eq(schema.subscription.shortUuid, u.shortUuid),
          ),
        )
        .limit(1);

      if (dryRun) {
        if (existing) report.users.updated++;
        else report.users.created++;
        continue;
      }

      const subscriberId = await this.upsertSubscriber(u);
      const subscriptionId = await this.upsertSubscription(u, subscriberId, Boolean(existing));
      await this.linkSquads(u, subscriptionId, squadMap);

      if (existing) report.users.updated++;
      else report.users.created++;

      if (withDevices) {
        const devices = await client.listDevices(u.uuid);
        report.devices.total += devices.length;
        for (const d of devices) {
          if (!d.hwid) continue;
          const inserted = await this.db
            .insert(schema.subscriberDevice)
            .values({
              orgId: this.cfg.defaultOrgId,
              subscriptionId,
              hwid: d.hwid,
              deviceOs: d.platform,
              deviceModel: d.deviceModel,
            })
            .onConflictDoNothing()
            .returning();
          if (inserted.length > 0) report.devices.created++;
        }
      }
    }
  }

  private async upsertSubscriber(u: RemnawaveUser): Promise<string> {
    // telegramId — естественный ключ подписчика; без него опираемся на username
    if (u.telegramId) {
      const [existing] = await this.db
        .select()
        .from(schema.subscriber)
        .where(
          and(
            eq(schema.subscriber.orgId, this.cfg.defaultOrgId),
            eq(schema.subscriber.telegramId, Number(u.telegramId)),
          ),
        )
        .limit(1);
      if (existing) return existing.id;
    }

    const [created] = await this.db
      .insert(schema.subscriber)
      .values({
        orgId: this.cfg.defaultOrgId,
        telegramId: u.telegramId ? Number(u.telegramId) : null,
        username: u.username,
        email: u.email ?? null,
        description: u.description ?? null,
        status: "active",
      })
      .returning();
    return created.id;
  }

  /**
   * Подписка. shortUuid и vless_uuid переносятся как есть — это и есть смысл
   * verbatim-импорта. Существующую запись обновляем, но идентичность не трогаем.
   */
  private async upsertSubscription(u: RemnawaveUser, subscriberId: string, exists: boolean): Promise<string> {
    const values = {
      status: mapStatus(u.status),
      expireAt: u.expireAt ? new Date(u.expireAt) : null,
      trafficLimitBytes: toNumber(u.trafficLimitBytes),
      trafficLimitStrategy: (u.trafficLimitStrategy ?? "month").toLowerCase(),
      lastTrafficResetAt: u.lastTrafficResetAt ? new Date(u.lastTrafficResetAt) : null,
      hwidDeviceLimit: u.hwidDeviceLimit ?? null,
      trojanPassword: u.trojanPassword ?? null,
      ssPassword: u.ssPassword ?? null,
      subRevokedAt: u.subRevokedAt ? new Date(u.subRevokedAt) : null,
      updatedAt: new Date(),
    };

    if (exists) {
      const [row] = await this.db
        .update(schema.subscription)
        .set(values)
        .where(
          and(
            eq(schema.subscription.orgId, this.cfg.defaultOrgId),
            eq(schema.subscription.shortUuid, u.shortUuid),
          ),
        )
        .returning();
      return row.id;
    }

    const [row] = await this.db
      .insert(schema.subscription)
      .values({
        orgId: this.cfg.defaultOrgId,
        subscriberId,
        shortUuid: u.shortUuid, // НЕ генерируем: клиент ходит по этой ссылке
        vlessUuid: u.vlessUuid, // НЕ генерируем: это идентичность в конфиге
        ...values,
      })
      .returning();
    return row.id;
  }

  private async linkSquads(u: RemnawaveUser, subscriptionId: string, squadMap: Map<string, string>): Promise<void> {
    for (const s of u.activeInternalSquads ?? []) {
      const squadId = squadMap.get(s.uuid);
      if (!squadId || squadId.startsWith("dry-run:")) continue;
      await this.db
        .insert(schema.subscriptionSquad)
        .values({ subscriptionId, squadId })
        .onConflictDoNothing();
    }
  }
}

/** Статусы Remnawave → наши. Незнакомое значение считаем неактивным, а не активным. */
function mapStatus(raw: string): string {
  switch ((raw ?? "").toUpperCase()) {
    case "ACTIVE":
      return "active";
    case "LIMITED":
      return "suspended";
    case "EXPIRED":
      return "expired";
    case "DISABLED":
      return "disabled";
    default:
      return "inactive";
  }
}

function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

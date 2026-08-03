import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { InfraImportService } from "./infra-import.service.js";
import { emptyReport, type ImportReport } from "./import.report.js";
import { RemnawaveClient, type RemnawaveSquad, type RemnawaveUser } from "./remnawave.client.js";

export type { ImportReport } from "./import.report.js";

type SubscriptionRow = typeof schema.subscription.$inferSelect;

/**
 * Куда ляжет идентичность панели:
 * exact — та же подписка (повторный импорт), adopt — подписка, заведённая ботом
 * до импорта, new — подписки ещё нет.
 */
type SubscriptionTarget =
  | { kind: "exact"; row: SubscriptionRow }
  | { kind: "adopt"; row: SubscriptionRow }
  | { kind: "new" };

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

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly infra: InfraImportService,
  ) {}

  async run(options: { dryRun?: boolean; withDevices?: boolean } = {}): Promise<ImportReport> {
    return this.runWith(new RemnawaveClient(this.cfg.remnawaveUrl, this.cfg.remnawaveToken), options);
  }

  /** Тот же импорт с готовым клиентом — точка подмены панели в тестах. */
  async runWith(
    client: RemnawaveClient,
    options: { dryRun?: boolean; withDevices?: boolean } = {},
  ): Promise<ImportReport> {
    const dryRun = options.dryRun !== false; // по умолчанию НЕ пишем
    const report = emptyReport(dryRun);

    if (!client.isConfigured()) {
      report.warnings.push("не заданы REMNAWAVE_URL / REMNAWAVE_TOKEN — импортировать неоткуда");
      return report;
    }

    // Инфраструктура — первым шагом: состав squad'ов связывается по тегу inbound'а,
    // и пока inbound'ов нет, squad'ы импортируются пустыми (клиент с конфигом,
    // которого нет ни на одной ноде).
    const plannedInboundTags = await this.infra.run(client, dryRun, report);

    const squadMap = await this.importSquads(client, dryRun, plannedInboundTags, report);
    await this.importUsers(client, dryRun, options.withDevices === true, squadMap, report);

    if (report.subscriptionsWithoutSquad > 0) {
      report.warnings.push(
        `подписок без единого squad'а: ${report.subscriptionsWithoutSquad} — они получат конфиг, но доступа к нодам не будет`,
      );
    }

    this.log.log(
      `импорт ${dryRun ? "(dry-run) " : ""}завершён: юзеров ${report.users.created}+${report.users.updated}` +
        `+${report.users.adopted}, squad'ов ${report.squads.created}, связей squad→inbound ` +
        `${report.squadInbounds.created}/${report.squadInbounds.total}, устройств ${report.devices.created}`,
    );
    return report;
  }

  /**
   * Squad'ы переносим первыми: на них ссылается доступ подписок к нодам.
   * Значение карты — id нашего squad'а, либо null, если в dry-run его ещё нет.
   */
  private async importSquads(
    client: RemnawaveClient,
    dryRun: boolean,
    plannedInboundTags: Set<string>,
    report: ImportReport,
  ): Promise<Map<string, string | null>> {
    const squads = await client.listSquads();
    report.squads.total = squads.length;
    const inboundsByTag = await this.loadInboundsByTag(dryRun ? plannedInboundTags : new Set());
    const map = new Map<string, string | null>();

    for (const s of squads) {
      const [existing] = await this.db
        .select()
        .from(schema.squad)
        .where(and(eq(schema.squad.orgId, this.cfg.defaultOrgId), eq(schema.squad.name, s.name)))
        .limit(1);

      let squadId: string | null = existing?.id ?? null;
      if (!existing) {
        report.squads.created++;
        if (!dryRun) {
          const [created] = await this.db
            .insert(schema.squad)
            .values({ orgId: this.cfg.defaultOrgId, name: s.name })
            .returning();
          squadId = created.id;
        }
      }

      map.set(s.uuid, squadId);
      await this.linkSquadInbounds(s, squadId, inboundsByTag, dryRun, report);
    }
    return map;
  }

  /**
   * Состав squad'а. Без строк squad_inbound подписка не попадает в desired-state
   * ноды: клиент получает валидный конфиг, а Xray рвёт хендшейк — такого
   * пользователя на ноде просто нет.
   *
   * Признак связывания — тег inbound'а. Тег это имя inbound'а в Xray-конфиге ноды,
   * он переезжает вместе с нодой и одинаков в обеих панелях. Имя config-профиля
   * таким признаком быть не может: профили заводятся у нас руками и
   * переименовываются независимо от панели, а uuid панели у нас не хранится вовсе.
   */
  private async linkSquadInbounds(
    squad: RemnawaveSquad,
    squadId: string | null,
    inboundsByTag: Map<string, string[]>,
    dryRun: boolean,
    report: ImportReport,
  ): Promise<void> {
    const panelInbounds = squad.inbounds;
    report.squadInbounds.total += panelInbounds.length;

    if (panelInbounds.length === 0) {
      report.warnings.push(
        `squad «${squad.name}»: в панели нет ни одного inbound'а — подписки этого squad'а останутся без доступа к нодам`,
      );
      return;
    }

    const targetIds = new Set<string>();
    const unmatched: string[] = [];
    for (const pi of panelInbounds) {
      const ours = inboundsByTag.get(pi.tag) ?? [];
      if (ours.length === 0) {
        unmatched.push(pi.tag);
        continue;
      }
      if (ours.length > 1) {
        // Один тег в нескольких config-профилях — у нас так быть не должно (1 профиль = 1 нода).
        // Связываем со всеми: недостающая связь = молчаливый отвал клиента, лишняя — видна в админке.
        report.warnings.push(
          `inbound-тег ${pi.tag} есть в ${ours.length} config-профилях — squad «${squad.name}» связан со всеми, проверьте вручную`,
        );
      }
      for (const id of ours) targetIds.add(id);
    }

    if (unmatched.length > 0) {
      report.warnings.push(
        `squad «${squad.name}»: inbound'ов ${unmatched.join(", ")} нет в нашей БД — ноды с ними ещё не заведены`,
      );
    }

    if (targetIds.size === 0) {
      report.warnings.push(
        `squad «${squad.name}»: не связан ни с одним inbound'ом — это не частичный успех, а тихий провал ` +
          `миграции: подписки squad'а получат конфиг, но Xray разорвёт хендшейк`,
      );
      return;
    }

    if (!squadId) {
      // dry-run на ещё не созданном squad'е: связей в БД нет, значит все будут новыми
      report.squadInbounds.created += targetIds.size;
      return;
    }

    if (dryRun) {
      const existing = await this.db
        .select({ inboundId: schema.squadInbound.inboundId })
        .from(schema.squadInbound)
        .where(eq(schema.squadInbound.squadId, squadId));
      const have = new Set(existing.map((r) => r.inboundId));
      report.squadInbounds.created += [...targetIds].filter((id) => !have.has(id)).length;
      return;
    }

    const inserted = await this.db
      .insert(schema.squadInbound)
      .values([...targetIds].map((inboundId) => ({ squadId, inboundId })))
      .onConflictDoNothing()
      .returning();
    report.squadInbounds.created += inserted.length;
  }

  /**
   * `planned` — теги, которые заведёт шаг инфраструктуры. Заполнен только в dry-run:
   * строк ещё нет, а показать связи надо, поэтому под такой тег кладётся
   * синтетический id. В БД он не попадёт — dry-run вообще не пишет.
   */
  private async loadInboundsByTag(planned: Set<string>): Promise<Map<string, string[]>> {
    const rows = await this.db
      .select({ id: schema.inbound.id, tag: schema.inbound.tag })
      .from(schema.inbound)
      .where(eq(schema.inbound.orgId, this.cfg.defaultOrgId));

    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.tag);
      if (list) list.push(row.id);
      else map.set(row.tag, [row.id]);
    }
    for (const tag of planned) if (!map.has(tag)) map.set(tag, [`plan:${tag}`]);
    return map;
  }

  private async importUsers(
    client: RemnawaveClient,
    dryRun: boolean,
    withDevices: boolean,
    squadMap: Map<string, string | null>,
    report: ImportReport,
  ): Promise<void> {
    const users = await client.listUsers();
    report.users.total = users.length;

    // Набор идентичностей панели: по нему отличаем подписку, заведённую ботом до
    // импорта (её short_uuid панели неизвестен), от уже импортированной.
    const panelShortUuids = new Set(users.map((u) => u.shortUuid).filter(Boolean));
    const adoptedInRun = new Set<string>();

    for (const u of users) {
      if (!u.shortUuid || !u.vlessUuid) {
        report.users.skipped++;
        report.warnings.push(`пользователь ${u.username ?? u.uuid}: нет shortUuid или vlessUuid — пропущен`);
        continue;
      }

      const subscriber = await this.findSubscriber(u);
      const target = await this.resolveTarget(u, subscriber?.id ?? null, panelShortUuids, adoptedInRun);

      if (dryRun) {
        this.countTarget(target.kind, report);
        // в dry-run в БД ничего нет — судим по составу squad'ов в панели
        if ((u.activeInternalSquads ?? []).length === 0) report.subscriptionsWithoutSquad++;
        continue;
      }

      // Подписчика заводим только когда подписки ещё нет: иначе повторный прогон
      // плодил бы осиротевших подписчиков у юзеров без telegram_id.
      const subscriberId =
        target.kind === "new" ? (subscriber?.id ?? (await this.createSubscriber(u))) : target.row.subscriberId;

      const subscriptionId = await this.upsertSubscription(u, subscriberId, target);
      if (target.kind === "adopt") adoptedInRun.add(target.row.id);
      await this.linkSquads(u, subscriptionId, squadMap);
      this.countTarget(target.kind, report);

      if (await this.hasNoSquads(subscriptionId)) report.subscriptionsWithoutSquad++;

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

  private countTarget(kind: SubscriptionTarget["kind"], report: ImportReport): void {
    if (kind === "exact") report.users.updated++;
    else if (kind === "adopt") report.users.adopted++;
    else report.users.created++;
  }

  /**
   * Куда класть идентичность юзера панели.
   *
   * Поиск только по shortUuid давал вторую подписку тому, кто успел нажать /start
   * до импорта: подписчик тот же, а short_uuid у ботовой подписки свой. Оплата
   * потом продлевала одну строку, а Happ ходил по другой — клиент без VPN.
   *
   * Вторая подписка у клиента при этом законна (куплена для близких), поэтому
   * присваиваем только ту, что не связана ни с одной идентичностью панели.
   */
  private async resolveTarget(
    u: RemnawaveUser,
    subscriberId: string | null,
    panelShortUuids: Set<string>,
    adoptedInRun: Set<string>,
  ): Promise<SubscriptionTarget> {
    const [exact] = await this.db
      .select()
      .from(schema.subscription)
      .where(
        and(
          eq(schema.subscription.orgId, this.cfg.defaultOrgId),
          eq(schema.subscription.shortUuid, u.shortUuid),
        ),
      )
      .limit(1);
    if (exact) return { kind: "exact", row: exact };

    if (!subscriberId) return { kind: "new" };

    const rows = await this.db
      .select()
      .from(schema.subscription)
      .where(
        and(
          eq(schema.subscription.orgId, this.cfg.defaultOrgId),
          eq(schema.subscription.subscriberId, subscriberId),
        ),
      )
      .orderBy(asc(schema.subscription.createdAt), asc(schema.subscription.id));

    const orphan = rows.find((r) => !panelShortUuids.has(r.shortUuid) && !adoptedInRun.has(r.id));
    return orphan ? { kind: "adopt", row: orphan } : { kind: "new" };
  }

  /** telegramId — естественный ключ подписчика. */
  private async findSubscriber(u: RemnawaveUser) {
    if (!u.telegramId) return null;
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
    return existing ?? null;
  }

  private async createSubscriber(u: RemnawaveUser): Promise<string> {
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
   * verbatim-импорта. Существующую импортированную запись обновляем, но
   * идентичность не трогаем.
   */
  private async upsertSubscription(
    u: RemnawaveUser,
    subscriberId: string,
    target: SubscriptionTarget,
  ): Promise<string> {
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

    if (target.kind === "exact") {
      const [row] = await this.db
        .update(schema.subscription)
        .set(values)
        .where(eq(schema.subscription.id, target.row.id))
        .returning();
      return row.id;
    }

    if (target.kind === "adopt") {
      const [row] = await this.db
        .update(schema.subscription)
        .set({ shortUuid: u.shortUuid, vlessUuid: u.vlessUuid, ...values })
        .where(eq(schema.subscription.id, target.row.id))
        .returning();
      this.log.warn(
        `подписка ${row.id}: заведена ботом до импорта, переведена на идентичность панели (${u.username ?? u.uuid})`,
      );
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

  private async linkSquads(
    u: RemnawaveUser,
    subscriptionId: string,
    squadMap: Map<string, string | null>,
  ): Promise<void> {
    for (const s of u.activeInternalSquads ?? []) {
      const squadId = squadMap.get(s.uuid);
      if (!squadId) continue;
      await this.db
        .insert(schema.subscriptionSquad)
        .values({ subscriptionId, squadId })
        .onConflictDoNothing();
    }
  }

  private async hasNoSquads(subscriptionId: string): Promise<boolean> {
    const rows = await this.db
      .select({ squadId: schema.subscriptionSquad.squadId })
      .from(schema.subscriptionSquad)
      .where(eq(schema.subscriptionSquad.subscriptionId, subscriptionId))
      .limit(1);
    return rows.length === 0;
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

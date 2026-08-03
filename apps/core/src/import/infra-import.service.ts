import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { InfraService, type Upserted } from "../nodes/infra.service.js";
import { FINGERPRINTS, NODE_ROLES, isIp } from "../nodes/infra.validation.js";
import type { EntityCount, ImportReport } from "./import.report.js";
import { realityPublicKey, stripRealityPrivateKey } from "./reality-pubkey.js";
import type {
  RemnawaveClient,
  RemnawaveConfigProfile,
  RemnawaveHost,
  RemnawaveInbound,
  RemnawaveNode,
} from "./remnawave.client.js";

type Body = Record<string, unknown>;

/** Что мы решили сделать из одного активного inbound'а панели. */
interface PlannedInbound {
  panelUuid: string;
  tag: string;
  body: Body;
  /** Reality-идентичность клиента: она же уедет в host. */
  pbk: string | null;
  sid: string | null;
  sni: string | null;
  flow: string;
  fingerprint: string;
}

interface PlannedNode {
  panelName: string;
  server: Body;
  profileName: string;
  node: Body;
  inbounds: PlannedInbound[];
}

/** Куда доехал активный inbound панели: наш id + нода, которая его обслуживает. */
interface ResolvedInbound {
  inboundId: string | null;
  nodeId: string | null;
  plan: PlannedInbound;
  ownerNodes: string[];
}

/**
 * Состояние одного прогона. `seen` держит натуральные ключи уже пройденных строк:
 * две ноды панели на одной коробке — это ОДИН наш сервер, и без этой памяти dry-run
 * посчитал бы его созданным дважды, то есть пообещал бы не то, что сделает запись.
 */
interface Ctx {
  dryRun: boolean;
  report: ImportReport;
  resolved: Map<string, ResolvedInbound>;
  seen: Set<string>;
}

/**
 * Перенос инфраструктуры с действующей панели: серверы, config-профили, ноды,
 * inbound'ы и host'ы. Строго read-only по отношению к Remnawave — только GET.
 *
 * Зачем это в импортёре, а не руками оператора: в боевой панели 14 тегов и 13
 * host'ов, и цена опечатки в `pbk`/`sid`/порте — клиент, который молча перестаёт
 * подключаться. Reality-идентичность переносится ДОСЛОВНО, включая вывод `pbk` из
 * приватника панели (сам приватник в БД не попадает никогда).
 *
 * Пишем только через InfraService: там валидация на границе и пересборка
 * desired-state. Свой путь записи означал бы вторую, расходящуюся модель того,
 * что такое корректный inbound.
 *
 * Общей транзакции на прогон нет намеренно: каждый шаг — upsert по натуральному
 * ключу, поэтому обрыв на середине оставляет часть парка перенесённой, а повторный
 * прогон доводит остальное. Одна транзакция на весь импорт держала бы блокировки
 * на 11 нод × 3 пересборки desired-state и всё равно откатывалась бы целиком
 * из-за одного кривого host'а — то есть меняла бы «дошло 12 из 13» на «не дошло ничего».
 */
@Injectable()
export class InfraImportService {
  private readonly log = new Logger(InfraImportService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly infra: InfraService,
  ) {}

  /**
   * Возвращает теги inbound'ов, которые после прогона будут в нашей БД. Нужны
   * следующему шагу импорта (состав squad'ов): в dry-run строк ещё нет, и без
   * этого списка отчёт показал бы 0 связей там, где apply сделает полтора десятка.
   */
  async run(client: RemnawaveClient, dryRun: boolean, report: ImportReport): Promise<Set<string>> {
    const [panelNodes, panelProfiles, panelHosts] = await Promise.all([
      client.listNodes(),
      client.listConfigProfiles(),
      client.listHosts(),
    ]);

    const plans = this.planNodes(panelNodes, panelProfiles, panelHosts, report);
    const ctx: Ctx = { dryRun, report, resolved: new Map(), seen: new Set() };

    for (const plan of plans) {
      try {
        await this.importNode(plan, ctx);
      } catch (err) {
        report.nodes.skipped++;
        report.warnings.push(`нода «${plan.panelName}» не перенесена: ${message(err)}`);
      }
    }

    await this.importHosts(panelHosts, ctx);

    this.log.log(
      `инфраструктура ${dryRun ? "(dry-run) " : ""}: серверы ${count(report.servers)}, профили ` +
        `${count(report.configProfiles)}, ноды ${count(report.nodes)}, inbound'ы ${count(report.inbounds)}, ` +
        `host'ы ${count(report.hosts)}`,
    );

    return new Set([...ctx.resolved.values()].map((r) => r.plan.tag));
  }

  // --- план ------------------------------------------------------------------

  /**
   * Модель панели (профиль на несколько нод) → наша (1 профиль = 1 нода,
   * node_config_profile_uq). Профиль режется по нодам, в профиль ноды попадают
   * только ЕЁ активные inbound'ы: остальные на этой ноде не подняты, и их приезд
   * в desired-state означал бы Xray, слушающий чужие порты.
   */
  private planNodes(
    panelNodes: RemnawaveNode[],
    panelProfiles: RemnawaveConfigProfile[],
    panelHosts: RemnawaveHost[],
    report: ImportReport,
  ): PlannedNode[] {
    const profileByUuid = new Map(panelProfiles.map((p) => [p.uuid, p]));
    const hostByInboundUuid = new Map<string, RemnawaveHost>();
    for (const h of panelHosts) {
      const uuid = h.inbound?.configProfileInboundUuid;
      if (uuid && !hostByInboundUuid.has(uuid)) hostByInboundUuid.set(uuid, h);
    }

    for (const p of panelProfiles) {
      if (p.nodes.length > 1) {
        report.warnings.push(
          `config-профиль «${p.name}» в панели общий для нод ${p.nodes.map((n) => n.name).join(", ")} — ` +
            `у нас 1 профиль = 1 нода, поэтому заведено ${p.nodes.length} отдельных профиля по имени ноды`,
        );
      }
    }

    const plans: PlannedNode[] = [];
    for (const pn of panelNodes) {
      const address = (pn.address ?? "").trim();
      // имя — натуральный ключ профиля, и в БД оно уже обрезано валидатором:
      // сравнивать и искать надо той же строкой, иначе повторный прогон не найдёт свою же строку
      const name = (pn.name ?? "").trim();
      if (!isIp(address)) {
        report.nodes.total++;
        report.nodes.skipped++;
        report.warnings.push(
          `нода «${name}»: адрес «${address}» не IP — сервер под неё завести не из чего, пропущена`,
        );
        continue;
      }

      const panelProfile = pn.configProfile?.activeConfigProfileUuid
        ? profileByUuid.get(pn.configProfile.activeConfigProfileUuid)
        : undefined;
      const active = pn.configProfile?.activeInbounds ?? [];
      if (active.length === 0) {
        report.warnings.push(
          `нода «${name}»: в панели не поднято ни одного inbound'а — переносим только саму ноду`,
        );
      }

      const inbounds: PlannedInbound[] = [];
      for (const pi of active) {
        const full = panelProfile?.inbounds.find((i) => i.uuid === pi.uuid) ?? pi;
        const planned = this.planInbound(pn, full, hostByInboundUuid.get(pi.uuid), report);
        if (planned) inbounds.push(planned);
        else report.inbounds.skipped++;
      }
      report.inbounds.total += active.length;

      plans.push({
        panelName: name,
        // hostname сервера — адрес ноды: DNS-имени коробки панель не отдаёт вовсе,
        // а адрес и есть то единственное, что физически идентифицирует сервер
        // (две ноды на одном IP = один сервер, наша модель это допускает)
        server: {
          hostname: address,
          primaryIp: address,
          country: pn.countryCode ?? null,
        },
        // Имя профиля = имя ноды. Ключом сопоставления при повторном прогоне служит
        // именно оно (config_profile_org_name_uq), а нода находится уже по профилю:
        // своего идентификатора панели мы не храним, и другого стабильного признака нет.
        // Переименование ноды в панели между прогонами будет выглядеть как новая нода —
        // на замороженной перед cutover'ом панели этого не происходит, а в отчёте видно.
        profileName: name,
        node: {
          name,
          roles: inferRoles(active),
          // не «active»: нодой пока управляет чужой control-plane. active её сделает
          // первый отчёт нашего агента (node-state.report)
          status: pn.isDisabled ? "disabled" : "provisioning",
          consumptionMultiplier: clampInt(pn.consumptionMultiplier ?? 1, 1, 100),
          trackTraffic: pn.isTrafficTrackingActive ?? true,
          sortOrder: clampInt(pn.viewPosition ?? 0, 0, 10_000),
        },
        inbounds,
      });
    }
    return plans;
  }

  /**
   * Inbound панели → наш. Всё, что не vless+reality, пропускаем осознанно:
   * генератор ноды собирает ровно reality, и строка с `security=none` доехала бы
   * до ноды всё тем же reality-инбаундом — то есть БД врала бы про то, что работает.
   */
  private planInbound(
    pn: RemnawaveNode,
    pi: RemnawaveInbound,
    host: RemnawaveHost | undefined,
    report: ImportReport,
  ): PlannedInbound | null {
    const where = `нода «${pn.name}», inbound ${pi.tag}`;
    const type = (pi.type ?? "").toLowerCase();
    const security = (pi.security ?? "").toLowerCase();
    if (type !== "vless" || security !== "reality") {
      report.warnings.push(
        `${where}: ${type || "?"}/${security || "?"} — наша модель ноды поддерживает только vless+reality, ` +
          `inbound не перенесён (и host на него тоже)`,
      );
      return null;
    }

    const reality = pi.rawInbound?.streamSettings?.realitySettings ?? {};
    const serverNames = reality.serverNames ?? [];
    const shortIds = reality.shortIds ?? [];
    const sni = serverNames[0] ?? null;
    const network = (pi.network ?? pi.rawInbound?.streamSettings?.network ?? "tcp").toLowerCase();
    const port = pi.port ?? pi.rawInbound?.port ?? null;

    if (!sni) {
      report.warnings.push(`${where}: в панели нет serverNames — reality без sni не поднимется, пропущен`);
      return null;
    }
    // Порт — то, куда стучится живой клиент. Подставить «обычные» 443 значило бы
    // завести канал, который выглядит рабочим и не отвечает.
    if (!port) {
      report.warnings.push(`${where}: панель не отдала порт — угадывать его нельзя, inbound не перенесён`);
      return null;
    }
    if (serverNames.length > 1) {
      report.warnings.push(`${where}: serverNames = ${serverNames.join(", ")}, переносим только первый (${sni})`);
    }
    if (shortIds.length === 0) {
      report.warnings.push(`${where}: в панели пустой shortIds — клиентам придётся ходить с пустым sid`);
    }
    if (shortIds.length > 1) {
      report.warnings.push(
        `${where}: shortIds = ${shortIds.join(", ")}; в host уедет первый (${shortIds[0]}) — сверьте с панелью`,
      );
    }
    const dest = reality.dest ?? "";
    if (dest && dest !== `${sni}:443`) {
      report.warnings.push(
        `${where}: dest в панели «${dest}», а наш генератор собирает его как «${sni}:443» — маскировка разъедется`,
      );
    }
    if (pi.rawInbound?.sniffing && pi.rawInbound.sniffing.enabled === false) {
      report.warnings.push(
        `${where}: в панели sniffing выключен, а наш генератор ноды включает его всегда (routeOnly) — ` +
          `для front-инбаунда это меняет поведение цепочки, проверьте до перехвата ноды`,
      );
    }

    const pbk = reality.privateKey ? realityPublicKey(reality.privateKey) : null;
    if (!pbk) {
      report.warnings.push(
        `${where}: панель не отдала приватник Reality — pbk вывести не из чего. Клиенты этого канала ` +
          `не подключатся, пока публичный ключ не будет проставлен (энроллмент агента или руками)`,
      );
    }

    // vision живёт только на tcp; на остальных транспортах Xray его не принимает.
    // Панель flow на inbound'е не хранит — она проставляет его клиентам при выдаче,
    // и в боевой подписке у всех tcp+reality стоит именно vision (сверено).
    const flow = network === "tcp" ? "xtls-rprx-vision" : "";
    const fingerprint = normalizeFingerprint(host?.fingerprint) ?? "firefox";

    return {
      panelUuid: pi.uuid,
      tag: pi.tag,
      pbk,
      sid: shortIds[0] ?? null,
      sni,
      flow,
      fingerprint,
      body: {
        tag: pi.tag,
        protocol: "vless",
        network,
        security: "reality",
        port,
        flow,
        sni,
        fingerprint,
        // Ключа нет — поля в body нет вовсе: null затёр бы pbk, проставленный
        // энроллментом агента между прогонами (см. providedOnly в InfraService).
        ...(pbk ? { realityPublicKey: pbk } : {}),
        ...(shortIds.length > 0 ? { shortIds } : {}),
        // сырой ответ панели для аудита — без приватника: строка в БД переживёт
        // и бэкапы, и выгрузки, а ключ должен остаться на ноде
        rawJson: pi.rawInbound ? stripRealityPrivateKey(pi.rawInbound) : null,
      },
    };
  }

  // --- запись ----------------------------------------------------------------

  private async importNode(plan: PlannedNode, ctx: Ctx): Promise<void> {
    const { report } = ctx;
    const serverKey = `server:${plan.server.hostname}`;
    const profileKey = `profile:${plan.profileName}`;
    if (!ctx.seen.has(serverKey)) report.servers.total++;
    if (!ctx.seen.has(profileKey)) report.configProfiles.total++;
    report.nodes.total++;

    const serverId = await this.step(
      ctx,
      report.servers,
      serverKey,
      () => this.findId(schema.server, eq(schema.server.hostname, String(plan.server.hostname))),
      () => this.infra.upsertServer(plan.server),
    );

    const configProfileId = await this.step(
      ctx,
      report.configProfiles,
      profileKey,
      () => this.findId(schema.configProfile, eq(schema.configProfile.name, plan.profileName)),
      () => this.infra.upsertConfigProfile({ name: plan.profileName }),
    );

    // Профиль, занятый ЧУЖОЙ нодой, — единственное место, где повторный прогон мог бы
    // сделать не то и не сказать: upsertNode нашёл бы ноду по профилю и переименовал её,
    // переставив на другой сервер. Такое совпадение имён — либо профиль, заведённый
    // оператором руками, либо переименование ноды у нас; и то и другое чинится в админке.
    const owner = configProfileId ? await this.findNodeByProfile(configProfileId) : null;
    if (owner && owner.name !== plan.node.name) {
      report.nodes.skipped++;
      report.warnings.push(
        `нода «${plan.panelName}»: config-профиль «${plan.profileName}» уже занят нодой «${owner.name}» — ` +
          `переименовывать чужую ноду импорт не станет (1 профиль = 1 нода). Разведите имена в админке и повторите`,
      );
      return;
    }

    const nodeId = await this.step(
      ctx,
      report.nodes,
      `node:${plan.profileName}`,
      async () => owner?.id ?? null,
      () => this.infra.upsertNode({ ...plan.node, serverId, configProfileId }),
    );

    for (const inbound of plan.inbounds) {
      const owners = ctx.resolved.get(inbound.panelUuid)?.ownerNodes ?? [];
      owners.push(plan.panelName);
      if (owners.length > 1) {
        report.inbounds.skipped++;
        report.warnings.push(
          `inbound ${inbound.tag} активен сразу на нодах ${owners.join(", ")} — host'ы привяжутся к первой ` +
            `(${owners[0]}), проверьте вручную`,
        );
        continue;
      }

      try {
        const inboundId = await this.step(
          ctx,
          report.inbounds,
          `inbound:${plan.profileName}:${inbound.tag}`,
          async () =>
            configProfileId
              ? this.findId(
                  schema.inbound,
                  and(eq(schema.inbound.configProfileId, configProfileId), eq(schema.inbound.tag, inbound.tag))!,
                )
              : null,
          () => this.infra.upsertInbound({ ...inbound.body, configProfileId }),
        );
        ctx.resolved.set(inbound.panelUuid, { inboundId, nodeId, plan: inbound, ownerNodes: owners });
      } catch (err) {
        report.inbounds.skipped++;
        report.warnings.push(`нода «${plan.panelName}», inbound ${inbound.tag} не перенесён: ${message(err)}`);
      }
    }
  }

  /**
   * Host — endpoint в подписке. Своей ноды панель у него не хранит (`nodes` пуст),
   * поэтому нода берётся через inbound: у нас профиль принадлежит одной ноде, значит
   * inbound однозначно указывает на неё. Несколько host'ов на один inbound — штатный
   * случай: это второй IP той же Reality-личности (DE.14 и DE.68 в бою).
   */
  private async importHosts(panelHosts: RemnawaveHost[], ctx: Ctx): Promise<void> {
    const { report } = ctx;
    report.hosts.total = panelHosts.length;
    let hidden = 0;
    const withHost = new Set<string>();

    for (const ph of panelHosts) {
      const panelInboundUuid = ph.inbound?.configProfileInboundUuid ?? "";
      const target = ctx.resolved.get(panelInboundUuid);
      if (!target) {
        report.hosts.skipped++;
        report.warnings.push(
          `host «${ph.remark}» (${ph.address}:${ph.port}): его inbound не перенесён или не поднят ни на одной ` +
            `ноде — канал в подписке придётся завести вручную`,
        );
        continue;
      }

      const body = {
        inboundId: target.inboundId,
        nodeId: target.nodeId,
        remark: ph.remark.slice(0, 128),
        address: ph.address,
        port: ph.port,
        // sni/fingerprint/alpn — из host'а панели: именно они лежат в конфигах живых
        // клиентов. pbk/sid берём из inbound'а — host их не хранит вовсе
        sni: ph.sni ?? target.plan.sni,
        fingerprint: normalizeFingerprint(ph.fingerprint) ?? target.plan.fingerprint,
        alpn: ph.alpn ?? null,
        ...(target.plan.pbk ? { pbk: target.plan.pbk } : {}),
        ...(target.plan.sid ? { sid: target.plan.sid } : {}),
        flow: target.plan.flow,
        // isHidden панели НЕ переносим: там он значит «ссылку собирает subgen, а не
        // сама панель» и стоит у 11 host'ов из 13. У нас же скрытый host выпадает из
        // всех подписок, и повторный импорт гасил бы канал, который оператор только
        // что открыл. Что показывать клиенту, у нас решают channel/profile; исходный
        // флаг остаётся в advanced.remnawave для аудита.
        isDisabled: ph.isDisabled ?? false,
        sortOrder: clampInt(ph.viewPosition ?? 0, 0, 10_000),
        advanced: { remnawave: ph as unknown as Record<string, unknown> },
      };
      if (ph.isHidden) hidden++;

      try {
        await this.step(
          ctx,
          report.hosts,
          `host:${target.plan.tag}:${ph.address}:${ph.port}`,
          async () =>
            target.inboundId
              ? this.findId(
                  schema.host,
                  and(
                    eq(schema.host.inboundId, target.inboundId),
                    eq(schema.host.address, ph.address),
                    eq(schema.host.port, ph.port),
                  )!,
                )
              : null,
          () => this.infra.upsertHost(body),
        );
        withHost.add(panelInboundUuid);
      } catch (err) {
        report.hosts.skipped++;
        report.warnings.push(`host «${ph.remark}» не перенесён: ${message(err)}`);
      }
    }

    // Endpoint'а на inbound панель может не хранить вовсе — так живут FRONT'ы каскада:
    // адрес фронта у Remnawave зашит в subgen, а у нас это host с tag_prefix=front.
    // Без него каскадное плечо соберётся в никуда, и заметно это будет только на клиенте.
    const orphanInbounds = [...ctx.resolved.values()].filter((r) => !withHost.has(r.plan.panelUuid));
    if (orphanInbounds.length > 0) {
      report.warnings.push(
        `inbound'ы без единого host'а в панели: ${orphanInbounds.map((r) => r.plan.tag).join(", ")} — ` +
          `endpoint для них придётся завести руками (для FRONT'а каскада — host с tag_prefix=front)`,
      );
    }

    if (hidden > 0) {
      report.warnings.push(
        `в панели скрыто host'ов: ${hidden} — у нас они заведены видимыми, потому что показывать клиенту ` +
          `решают channel/profile, а не флаг панели. Исходное значение осталось в advanced.remnawave`,
      );
    }
  }

  /**
   * Один шаг импорта: в dry-run только смотрим, есть ли строка (и тогда прогон был бы
   * обновлением), при apply пишем через InfraService. Счётчик один и тот же, поэтому
   * dry-run не может «пообещать» не то, что сделает запись.
   */
  private async step(
    ctx: Ctx,
    counter: EntityCount,
    key: string,
    probe: () => Promise<string | null>,
    write: () => Promise<Upserted<{ id: string }>>,
  ): Promise<string | null> {
    const repeat = ctx.seen.has(key);
    ctx.seen.add(key);

    if (ctx.dryRun) {
      const id = await probe();
      if (id || repeat) counter.updated++;
      else counter.created++;
      return id;
    }
    const { row, created } = await write();
    if (created) counter.created++;
    else counter.updated++;
    return row.id;
  }

  private async findId(
    table: typeof schema.server | typeof schema.configProfile | typeof schema.inbound | typeof schema.host,
    where: ReturnType<typeof eq>,
  ): Promise<string | null> {
    const rows = await this.db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.orgId, this.cfg.defaultOrgId), where))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  private async findNodeByProfile(configProfileId: string): Promise<{ id: string; name: string } | null> {
    const rows = await this.db
      .select({ id: schema.node.id, name: schema.node.name })
      .from(schema.node)
      .where(and(eq(schema.node.orgId, this.cfg.defaultOrgId), eq(schema.node.configProfileId, configProfileId)))
      .limit(1);
    return rows[0] ?? null;
  }
}

/**
 * Ролей панель не хранит — признаком служит наше же соглашение об именовании
 * inbound'ов (`*_RELAY_IN` — вход каскада, `*_FRONT` — freedom-front). На генерацию
 * конфига роль не влияет, это подпись для оператора.
 */
function inferRoles(inbounds: RemnawaveInbound[]): string[] {
  const roles = new Set<string>();
  for (const i of inbounds) {
    const tag = (i.tag ?? "").toUpperCase();
    if (tag.includes("RELAY_IN")) roles.add("relay");
    else if (tag.includes("FRONT")) roles.add("front");
    else roles.add("exit");
  }
  if (roles.size === 0) roles.add("exit");
  return NODE_ROLES.filter((r) => roles.has(r));
}

function normalizeFingerprint(value: string | null | undefined): string | null {
  const fp = (value ?? "").trim().toLowerCase();
  return (FINGERPRINTS as readonly string[]).includes(fp) ? fp : null;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number(value) || min)));
}

function count(c: EntityCount): string {
  return `${c.created}/${c.updated}/${c.skipped}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

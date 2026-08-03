import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { NodeStateService } from "./node-state.service.js";
import {
  FINGERPRINTS,
  INBOUND_FLOWS,
  INBOUND_NETWORKS,
  INBOUND_PROTOCOLS,
  INBOUND_SECURITY,
  NODE_STATUSES,
  type Raw,
  addressStr,
  alpnStr,
  assertInboundShape,
  bad,
  bool,
  enumOf,
  has,
  hostnameStr,
  ipArray,
  ipStr,
  nullableStr,
  num,
  obj,
  portNum,
  realityPubkeyStr,
  requireUuid,
  roleArray,
  shortIdArray,
  shortIdStr,
  str,
  tagStr,
  uuidStr,
} from "./infra.validation.js";

export interface RebuildInfo {
  nodeId: string;
  name: string;
  version: number;
  changed: boolean;
}

/** Результат upsert'а: строка + чем он оказался на самом деле. Счётчики импорта считают по `created`. */
export interface Upserted<T> {
  row: T;
  created: boolean;
  rebuilt?: RebuildInfo[];
}

const PG_UNIQUE_VIOLATION = "23505";

/**
 * Заведение сети из админки: серверы, config-профили, ноды, inbound'ы, host'ы, squad'ы.
 *
 * Два сквозных правила.
 *   1. Любая правка, от которой зависит конфиг ноды, заканчивается пересборкой
 *      desired-state (тот же NodeStateService.rebuild, что за кнопкой «Пересобрать»).
 *      Без этого правка доезжает до ноды только следующим sweep'ом — то есть
 *      «когда-нибудь» вместо «сейчас», и снаружи выглядит как молчаливая потеря.
 *   2. Указатели на секреты (server.ssh_ref, inbound.reality_privkey_ref, inbound.raw_json)
 *      наружу не отдаются — только признак «задан».
 */
@Injectable()
export class InfraService {
  private readonly log = new Logger(InfraService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly state: NodeStateService,
  ) {}

  private get org(): string {
    return this.cfg.defaultOrgId;
  }

  // --- серверы ---------------------------------------------------------------

  async listServers() {
    const rows = await this.db
      .select()
      .from(schema.server)
      .where(eq(schema.server.orgId, this.org))
      .orderBy(schema.server.hostname);

    const nodes = await this.db
      .select({ serverId: schema.node.serverId, n: sql<number>`count(*)::int` })
      .from(schema.node)
      .where(eq(schema.node.orgId, this.org))
      .groupBy(schema.node.serverId);
    const byServer = new Map(nodes.map((r) => [r.serverId, r.n]));

    return rows.map((s) => ({ ...hideServerSecrets(s), nodeCount: byServer.get(s.id) ?? 0 }));
  }

  private serverValues(body: Raw) {
    return {
      orgId: this.org,
      hostname: hostnameStr(body, "hostname", { required: true })!,
      primaryIp: ipStr(body, "primaryIp", { required: true })!,
      extraIps: ipArray(body, "extraIps") ?? [],
      country: nullableStr(body, "country", { max: 8, upper: true }) ?? null,
      sshRef: nullableStr(body, "sshRef", { max: 256 }) ?? null,
      capabilities: obj(body, "capabilities") ?? {},
    };
  }

  async createServer(body: Raw) {
    const values = this.serverValues(body);
    const [row] = await this.db
      .insert(schema.server)
      .values(values)
      .onConflictDoNothing({ target: [schema.server.orgId, schema.server.hostname] })
      .returning();
    if (!row) throw new ConflictException(`сервер с hostname ${values.hostname} уже заведён`);
    return hideServerSecrets(row);
  }

  async updateServer(id: string, body: Raw) {
    requireUuid(id);
    const values = compact({
      hostname: hostnameStr(body, "hostname"),
      primaryIp: ipStr(body, "primaryIp"),
      extraIps: ipArray(body, "extraIps"),
      country: nullableStr(body, "country", { max: 8, upper: true }),
      sshRef: nullableStr(body, "sshRef", { max: 256 }),
      capabilities: obj(body, "capabilities"),
    });
    assertNotEmpty(values);

    const [row] = await this.db
      .update(schema.server)
      .set(values)
      .where(and(eq(schema.server.orgId, this.org), eq(schema.server.id, id)))
      .returning();
    if (!row) throw new NotFoundException(`сервер ${id} не найден`);
    return hideServerSecrets(row);
  }

  async deleteServer(id: string) {
    requireUuid(id);
    const nodes = await this.db
      .select({ name: schema.node.name })
      .from(schema.node)
      .where(and(eq(schema.node.orgId, this.org), eq(schema.node.serverId, id)));
    if (nodes.length > 0) {
      throw new ConflictException(`на сервере стоят ноды: ${nodes.map((n) => n.name).join(", ")} — сначала удалите их`);
    }

    const [row] = await this.db
      .delete(schema.server)
      .where(and(eq(schema.server.orgId, this.org), eq(schema.server.id, id)))
      .returning({ id: schema.server.id });
    if (!row) throw new NotFoundException(`сервер ${id} не найден`);
    return { ok: true };
  }

  // --- config-профили --------------------------------------------------------

  async listConfigProfiles() {
    const rows = await this.db
      .select()
      .from(schema.configProfile)
      .where(eq(schema.configProfile.orgId, this.org))
      .orderBy(schema.configProfile.name);

    const nodes = await this.db
      .select({ id: schema.node.id, name: schema.node.name, configProfileId: schema.node.configProfileId })
      .from(schema.node)
      .where(eq(schema.node.orgId, this.org));
    const inbounds = await this.db
      .select({ configProfileId: schema.inbound.configProfileId, n: sql<number>`count(*)::int` })
      .from(schema.inbound)
      .where(eq(schema.inbound.orgId, this.org))
      .groupBy(schema.inbound.configProfileId);
    const inboundCount = new Map(inbounds.map((r) => [r.configProfileId, r.n]));

    return rows.map((p) => {
      const owner = nodes.find((n) => n.configProfileId === p.id);
      return {
        ...p,
        nodeId: owner?.id ?? null,
        nodeName: owner?.name ?? null,
        inboundCount: inboundCount.get(p.id) ?? 0,
      };
    });
  }

  async createConfigProfile(body: Raw) {
    const [row] = await this.db
      .insert(schema.configProfile)
      .values({
        orgId: this.org,
        name: str(body, "name", { required: true, max: 128 })!,
        baseJson: obj(body, "baseJson") ?? {},
      })
      .returning();
    return row;
  }

  async updateConfigProfile(id: string, body: Raw) {
    requireUuid(id);
    const values = compact({
      name: str(body, "name", { max: 128 }),
      baseJson: obj(body, "baseJson"),
    });
    assertNotEmpty(values);

    const [row] = await this.db
      .update(schema.configProfile)
      .set(values)
      .where(and(eq(schema.configProfile.orgId, this.org), eq(schema.configProfile.id, id)))
      .returning();
    if (!row) throw new NotFoundException(`config-профиль ${id} не найден`);

    return { ...row, rebuilt: await this.rebuildProfileNodes(id) };
  }

  async deleteConfigProfile(id: string) {
    requireUuid(id);
    const nodes = await this.db
      .select({ name: schema.node.name })
      .from(schema.node)
      .where(and(eq(schema.node.orgId, this.org), eq(schema.node.configProfileId, id)));
    const inbounds = await this.db
      .select({ tag: schema.inbound.tag })
      .from(schema.inbound)
      .where(and(eq(schema.inbound.orgId, this.org), eq(schema.inbound.configProfileId, id)));

    const blockers = [
      ...nodes.map((n) => `нода «${n.name}»`),
      ...inbounds.map((i) => `inbound ${i.tag}`),
    ];
    if (blockers.length > 0) throw new ConflictException(`профиль занят: ${blockers.join(", ")}`);

    const [row] = await this.db
      .delete(schema.configProfile)
      .where(and(eq(schema.configProfile.orgId, this.org), eq(schema.configProfile.id, id)))
      .returning({ id: schema.configProfile.id });
    if (!row) throw new NotFoundException(`config-профиль ${id} не найден`);
    return { ok: true };
  }

  // --- ноды ------------------------------------------------------------------

  private async nodeValues(body: Raw) {
    const serverId = uuidStr(body, "serverId", { required: true })!;
    const configProfileId = uuidStr(body, "configProfileId", { required: true })!;
    await this.assertServerExists(serverId);
    await this.assertConfigProfileExists(configProfileId);

    return {
      orgId: this.org,
      serverId,
      configProfileId,
      name: str(body, "name", { required: true, max: 128 })!,
      roles: roleArray(body, "roles", { required: true })!,
      status: enumOf(body, "status", NODE_STATUSES) ?? "provisioning",
      consumptionMultiplier: num(body, "consumptionMultiplier", { min: 1, max: 100 }) ?? 1,
      trackTraffic: bool(body, "trackTraffic") ?? true,
      sortOrder: num(body, "sortOrder", { min: 0, max: 10_000 }) ?? 0,
    };
  }

  async createNode(body: Raw) {
    const values = await this.nodeValues(body);
    const { configProfileId } = values;

    let row: typeof schema.node.$inferSelect;
    try {
      [row] = await this.db.insert(schema.node).values(values).returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw profileTakenError(configProfileId);
      throw err;
    }

    // desired-state сразу: иначе нода висит в списке без версии, и по ней не видно,
    // сошлась она или ещё не получала конфига
    return { ...row, rebuilt: await this.rebuildNodes([row.id]) };
  }

  async updateNode(id: string, body: Raw) {
    requireUuid(id);
    const serverId = uuidStr(body, "serverId");
    const configProfileId = uuidStr(body, "configProfileId");
    if (serverId) await this.assertServerExists(serverId);
    if (configProfileId) await this.assertConfigProfileExists(configProfileId);

    const values = compact({
      serverId,
      configProfileId,
      name: str(body, "name", { max: 128 }),
      roles: roleArray(body, "roles"),
      status: enumOf(body, "status", NODE_STATUSES),
      consumptionMultiplier: num(body, "consumptionMultiplier", { min: 1, max: 100 }),
      trackTraffic: bool(body, "trackTraffic"),
      sortOrder: num(body, "sortOrder", { min: 0, max: 10_000 }),
    });
    assertNotEmpty(values);

    let row: typeof schema.node.$inferSelect | undefined;
    try {
      [row] = await this.db
        .update(schema.node)
        .set(values)
        .where(and(eq(schema.node.orgId, this.org), eq(schema.node.id, id)))
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw profileTakenError(configProfileId ?? "");
      throw err;
    }
    if (!row) throw new NotFoundException(`нода ${id} не найдена`);

    return { ...row, rebuilt: await this.rebuildNodes([id]) };
  }

  /**
   * Физическое удаление — только у ноды, на которую никто не ссылается.
   * Собственное состояние (identity/desired/reported) уходит вместе с ней: оно 1:1
   * и без ноды не значит ничего. Чужие ссылки (host'ы, каскады, накопленный трафик) —
   * повод отказать: снести их «заодно» значит потерять учёт задним числом.
   */
  async deleteNode(id: string) {
    requireUuid(id);
    const hosts = await this.db
      .select({ remark: schema.host.remark })
      .from(schema.host)
      .where(eq(schema.host.nodeId, id));

    const blockers = [
      ...hosts.map((h) => `host «${h.remark}»`),
      ...(await this.refCount(sql`select count(*)::int as n from cascade_link
        where exit_node_id = ${id} or relay_node_id = ${id} or front_node_id = ${id}`, "каскад")),
      ...(await this.refCount(sql`select count(*)::int as n from channel where front_node_id = ${id}`, "канал подписки (front)")),
      ...(await this.refCount(sql`select count(*)::int as n from traffic_sample where node_id = ${id}`, "запись трафика")),
      ...(await this.refCount(sql`select count(*)::int as n from traffic_daily where node_id = ${id}`, "агрегат трафика")),
      ...(await this.refCount(sql`select count(*)::int as n from traffic_report where node_id = ${id}`, "отчёт агента")),
      ...(await this.refCount(sql`select count(*)::int as n from abuse_signal where node_id = ${id}`, "сигнал абьюза")),
      ...(await this.refCount(sql`select count(*)::int as n from torrent_ban where node_id = ${id}`, "торрент-бан")),
      ...(await this.refCount(sql`select count(*)::int as n from online_state where node_id = ${id}`, "online-состояние")),
    ];
    if (blockers.length > 0) {
      throw new ConflictException(`на ноду ссылаются: ${blockers.join(", ")} — удалить нельзя`);
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(schema.nodeIdentity).where(eq(schema.nodeIdentity.nodeId, id));
      await tx.delete(schema.nodeDesiredState).where(eq(schema.nodeDesiredState.nodeId, id));
      await tx.delete(schema.nodeReportedState).where(eq(schema.nodeReportedState.nodeId, id));
      const [row] = await tx
        .delete(schema.node)
        .where(and(eq(schema.node.orgId, this.org), eq(schema.node.id, id)))
        .returning({ id: schema.node.id });
      if (!row) throw new NotFoundException(`нода ${id} не найдена`);
    });
    return { ok: true };
  }

  // --- inbound'ы -------------------------------------------------------------

  async listInbounds() {
    const rows = await this.db
      .select({ i: schema.inbound, nodeId: schema.node.id, nodeName: schema.node.name })
      .from(schema.inbound)
      .leftJoin(schema.node, eq(schema.node.configProfileId, schema.inbound.configProfileId))
      .where(eq(schema.inbound.orgId, this.org))
      .orderBy(schema.inbound.tag);

    return rows.map(({ i, nodeId, nodeName }) => ({ ...hideInboundSecrets(i), nodeId, nodeName }));
  }

  private async inboundValues(body: Raw) {
    const configProfileId = uuidStr(body, "configProfileId", { required: true })!;
    await this.assertConfigProfileExists(configProfileId);

    return {
      orgId: this.org,
      configProfileId,
      tag: tagStr(body, "tag", { required: true })!,
      protocol: enumOf(body, "protocol", INBOUND_PROTOCOLS) ?? "vless",
      network: enumOf(body, "network", INBOUND_NETWORKS) ?? "tcp",
      security: enumOf(body, "security", INBOUND_SECURITY) ?? "reality",
      port: portNum(body, "port", { required: true })!,
      flow: enumOf(body, "flow", INBOUND_FLOWS, { allowEmpty: true }) ?? "xtls-rprx-vision",
      sni: nullableStr(body, "sni", { max: 253 }) ?? null,
      fingerprint: enumOf(body, "fingerprint", FINGERPRINTS) ?? "firefox",
      realityPublicKey: realityPubkeyStr(body, "realityPublicKey") ?? null,
      shortIds: shortIdArray(body, "shortIds") ?? [],
      params: obj(body, "params") ?? {},
      realityPrivkeyRef: nullableStr(body, "realityPrivkeyRef", { max: 256 }) ?? null,
    };
  }

  async createInbound(body: Raw) {
    const values = await this.inboundValues(body);
    const { configProfileId } = values;
    assertInboundShape(values);

    const [row] = await this.db
      .insert(schema.inbound)
      .values(values)
      .onConflictDoNothing({ target: [schema.inbound.configProfileId, schema.inbound.tag] })
      .returning();
    if (!row) throw new ConflictException(`inbound с тегом ${values.tag} в этом профиле уже есть`);

    return { ...hideInboundSecrets(row), rebuilt: await this.rebuildProfileNodes(configProfileId) };
  }

  async updateInbound(id: string, body: Raw) {
    requireUuid(id);
    const current = await this.requireInbound(id);

    const values = compact({
      tag: tagStr(body, "tag"),
      protocol: enumOf(body, "protocol", INBOUND_PROTOCOLS),
      network: enumOf(body, "network", INBOUND_NETWORKS),
      security: enumOf(body, "security", INBOUND_SECURITY),
      port: portNum(body, "port"),
      flow: enumOf(body, "flow", INBOUND_FLOWS, { allowEmpty: true }),
      sni: nullableStr(body, "sni", { max: 253 }),
      fingerprint: enumOf(body, "fingerprint", FINGERPRINTS),
      realityPublicKey: realityPubkeyStr(body, "realityPublicKey"),
      shortIds: shortIdArray(body, "shortIds"),
      params: obj(body, "params"),
      realityPrivkeyRef: nullableStr(body, "realityPrivkeyRef", { max: 256 }),
    });
    assertNotEmpty(values);
    assertInboundShape({ ...current, ...values });

    // тег — это ссылка из cascade_link.exit_inbound_tag: переименование увело бы
    // каскад в никуда, причём без единой ошибки
    if (values.tag && values.tag !== current.tag) {
      const used = await this.cascadesByExitTag(current.configProfileId, current.tag);
      if (used.length > 0) {
        throw new ConflictException(`тег ${current.tag} держат каскады: ${used.join(", ")} — сначала пересоберите их`);
      }
    }

    const [row] = await this.db
      .update(schema.inbound)
      .set(values)
      .where(and(eq(schema.inbound.orgId, this.org), eq(schema.inbound.id, id)))
      .returning();
    if (!row) throw new NotFoundException(`inbound ${id} не найден`);

    return { ...hideInboundSecrets(row), rebuilt: await this.rebuildProfileNodes(row.configProfileId) };
  }

  async deleteInbound(id: string) {
    requireUuid(id);
    const current = await this.requireInbound(id);

    const squads = await this.db
      .select({ name: schema.squad.name })
      .from(schema.squadInbound)
      .innerJoin(schema.squad, eq(schema.squadInbound.squadId, schema.squad.id))
      .where(eq(schema.squadInbound.inboundId, id));
    const hosts = await this.db
      .select({ remark: schema.host.remark })
      .from(schema.host)
      .where(eq(schema.host.inboundId, id));
    const cascades = await this.cascadesByExitTag(current.configProfileId, current.tag);

    const blockers = [
      ...squads.map((s) => `squad «${s.name}»`),
      ...hosts.map((h) => `host «${h.remark}»`),
      ...cascades.map((c) => `каскад ${c}`),
    ];
    if (blockers.length > 0) {
      throw new ConflictException(`inbound ${current.tag} используется: ${blockers.join(", ")} — сначала отвяжите`);
    }

    await this.db.delete(schema.inbound).where(and(eq(schema.inbound.orgId, this.org), eq(schema.inbound.id, id)));
    return { ok: true, rebuilt: await this.rebuildProfileNodes(current.configProfileId) };
  }

  private async requireInbound(id: string) {
    const [row] = await this.db
      .select()
      .from(schema.inbound)
      .where(and(eq(schema.inbound.orgId, this.org), eq(schema.inbound.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException(`inbound ${id} не найден`);
    return row;
  }

  /** Каскады, чей exit смотрит на этот тег ИМЕННО этого профиля: теги повторяются между профилями. */
  private async cascadesByExitTag(configProfileId: string, exitTag: string): Promise<string[]> {
    const rows = await this.db
      .select({ cc: schema.cascadeLink.cc, id: schema.cascadeLink.id })
      .from(schema.cascadeLink)
      .innerJoin(schema.node, eq(schema.cascadeLink.exitNodeId, schema.node.id))
      .where(
        and(
          eq(schema.cascadeLink.orgId, this.org),
          eq(schema.cascadeLink.exitInboundTag, exitTag),
          eq(schema.node.configProfileId, configProfileId),
        ),
      );
    return rows.map((r) => `${r.cc} (${r.id.slice(0, 8)})`);
  }

  // --- host'ы ----------------------------------------------------------------

  async listHosts() {
    const rows = await this.db
      .select({
        h: schema.host,
        inboundTag: schema.inbound.tag,
        nodeName: schema.node.name,
        channelCount: sql<number>`(select count(*)::int from channel where channel.host_id = ${schema.host.id})`,
      })
      .from(schema.host)
      .leftJoin(schema.inbound, eq(schema.host.inboundId, schema.inbound.id))
      .leftJoin(schema.node, eq(schema.host.nodeId, schema.node.id))
      .where(eq(schema.host.orgId, this.org))
      .orderBy(schema.host.sortOrder, schema.host.remark);

    return rows.map(({ h, inboundTag, nodeName, channelCount }) => ({ ...h, inboundTag, nodeName, channelCount }));
  }

  private async hostValues(body: Raw) {
    const inboundId = uuidStr(body, "inboundId", { required: true })!;
    const nodeId = uuidStr(body, "nodeId", { required: true })!;
    await this.assertInboundExists(inboundId);
    await this.assertNodeExists(nodeId);

    return {
      orgId: this.org,
      inboundId,
      nodeId,
      remark: str(body, "remark", { required: true, max: 128 })!,
      address: addressStr(body, "address", { required: true })!,
      port: portNum(body, "port", { required: true })!,
      sni: nullableStr(body, "sni", { max: 253 }) ?? null,
      fingerprint: enumOf(body, "fingerprint", FINGERPRINTS) ?? "firefox",
      alpn: alpnStr(body, "alpn") ?? null,
      pbk: nullableStr(body, "pbk", { max: 128 }) ?? null,
      sid: shortIdStr(body, "sid") ?? null,
      flow: enumOf(body, "flow", INBOUND_FLOWS, { allowEmpty: true }) ?? "xtls-rprx-vision",
      tagPrefix: nullableStr(body, "tagPrefix", { max: 64 }) ?? null,
      isHidden: bool(body, "isHidden") ?? false,
      isDisabled: bool(body, "isDisabled") ?? false,
      sortOrder: num(body, "sortOrder", { min: 0, max: 10_000 }) ?? 0,
      advanced: obj(body, "advanced") ?? {},
    };
  }

  async createHost(body: Raw) {
    const values = await this.hostValues(body);
    const [row] = await this.db.insert(schema.host).values(values).returning();
    return { ...row, rebuilt: await this.rebuildCascadeRelays(values.nodeId) };
  }

  async updateHost(id: string, body: Raw) {
    requireUuid(id);
    const inboundId = uuidStr(body, "inboundId");
    const nodeId = uuidStr(body, "nodeId");
    if (inboundId) await this.assertInboundExists(inboundId);
    if (nodeId) await this.assertNodeExists(nodeId);

    const values = compact({
      inboundId,
      nodeId,
      remark: str(body, "remark", { max: 128 }),
      address: addressStr(body, "address"),
      port: portNum(body, "port"),
      sni: nullableStr(body, "sni", { max: 253 }),
      fingerprint: enumOf(body, "fingerprint", FINGERPRINTS),
      alpn: alpnStr(body, "alpn"),
      pbk: nullableStr(body, "pbk", { max: 128 }),
      sid: has(body, "sid") ? (shortIdStr(body, "sid") ?? null) : undefined,
      flow: enumOf(body, "flow", INBOUND_FLOWS, { allowEmpty: true }),
      tagPrefix: nullableStr(body, "tagPrefix", { max: 64 }),
      isHidden: bool(body, "isHidden"),
      isDisabled: bool(body, "isDisabled"),
      sortOrder: num(body, "sortOrder", { min: 0, max: 10_000 }),
      advanced: obj(body, "advanced"),
    });
    assertNotEmpty(values);

    const [row] = await this.db
      .update(schema.host)
      .set(values)
      .where(and(eq(schema.host.orgId, this.org), eq(schema.host.id, id)))
      .returning();
    if (!row) throw new NotFoundException(`host ${id} не найден`);

    return { ...row, rebuilt: await this.rebuildCascadeRelays(row.nodeId) };
  }

  async deleteHost(id: string) {
    requireUuid(id);
    const channels = await this.db
      .select({ tag: schema.channel.tag })
      .from(schema.channel)
      .where(and(eq(schema.channel.orgId, this.org), eq(schema.channel.hostId, id)));
    if (channels.length > 0) {
      throw new ConflictException(
        `host держат каналы подписки: ${channels.map((c) => c.tag).join(", ")} — сначала удалите их`,
      );
    }

    const [row] = await this.db
      .delete(schema.host)
      .where(and(eq(schema.host.orgId, this.org), eq(schema.host.id, id)))
      .returning({ nodeId: schema.host.nodeId });
    if (!row) throw new NotFoundException(`host ${id} не найден`);
    return { ok: true, rebuilt: await this.rebuildCascadeRelays(row.nodeId) };
  }

  // --- squad'ы ---------------------------------------------------------------

  async listSquads() {
    const rows = await this.db
      .select()
      .from(schema.squad)
      .where(eq(schema.squad.orgId, this.org))
      .orderBy(schema.squad.name);
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    const links = await this.db
      .select({
        squadId: schema.squadInbound.squadId,
        inboundId: schema.squadInbound.inboundId,
        tag: schema.inbound.tag,
      })
      .from(schema.squadInbound)
      .innerJoin(schema.inbound, eq(schema.squadInbound.inboundId, schema.inbound.id))
      .where(inArray(schema.squadInbound.squadId, ids));

    const subs = await this.db
      .select({ squadId: schema.subscriptionSquad.squadId, n: sql<number>`count(*)::int` })
      .from(schema.subscriptionSquad)
      .where(inArray(schema.subscriptionSquad.squadId, ids))
      .groupBy(schema.subscriptionSquad.squadId);
    const subCount = new Map(subs.map((s) => [s.squadId, s.n]));

    return rows.map((s) => ({
      ...s,
      inbounds: links.filter((l) => l.squadId === s.id).map((l) => ({ id: l.inboundId, tag: l.tag })),
      subscriptionCount: subCount.get(s.id) ?? 0,
    }));
  }

  async createSquad(body: Raw) {
    const name = str(body, "name", { required: true, max: 128 })!;
    const inboundIds = await this.validateInboundIds(body);

    const [row] = await this.db.insert(schema.squad).values({ orgId: this.org, name }).returning();
    const rebuilt = inboundIds ? await this.setSquadInbounds(row.id, inboundIds) : [];
    return { ...row, inboundIds: inboundIds ?? [], rebuilt };
  }

  /** inboundIds — полная замена состава: одна форма правит набор целиком. */
  async updateSquad(id: string, body: Raw) {
    requireUuid(id);
    const name = str(body, "name", { max: 128 });
    const inboundIds = await this.validateInboundIds(body);
    if (name === undefined && inboundIds === undefined) bad("нечего обновлять");

    if (name !== undefined) {
      const [row] = await this.db
        .update(schema.squad)
        .set({ name })
        .where(and(eq(schema.squad.orgId, this.org), eq(schema.squad.id, id)))
        .returning();
      if (!row) throw new NotFoundException(`squad ${id} не найден`);
    } else {
      await this.assertSquadExists(id);
    }

    const rebuilt = inboundIds ? await this.setSquadInbounds(id, inboundIds) : [];
    const [fresh] = await this.db.select().from(schema.squad).where(eq(schema.squad.id, id)).limit(1);
    return { ...fresh, inboundIds: inboundIds ?? (await this.squadInboundIds(id)), rebuilt };
  }

  async deleteSquad(id: string) {
    requireUuid(id);
    const [subs] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.subscriptionSquad)
      .where(eq(schema.subscriptionSquad.squadId, id));
    if ((subs?.n ?? 0) > 0) {
      throw new ConflictException(`к squad'у привязано подписок: ${subs.n} — сначала переведите их`);
    }

    const plans = await this.db
      .select({ code: schema.plan.code })
      .from(schema.plan)
      .where(and(eq(schema.plan.orgId, this.org), sql`${schema.plan.squadIds} @> ${JSON.stringify([id])}::jsonb`));
    if (plans.length > 0) {
      throw new ConflictException(`squad указан в тарифах: ${plans.map((p) => p.code).join(", ")} — сначала уберите`);
    }

    const affected = await this.nodesByInboundIds(await this.squadInboundIds(id));
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.squadInbound).where(eq(schema.squadInbound.squadId, id));
      const [row] = await tx
        .delete(schema.squad)
        .where(and(eq(schema.squad.orgId, this.org), eq(schema.squad.id, id)))
        .returning({ id: schema.squad.id });
      if (!row) throw new NotFoundException(`squad ${id} не найден`);
    });
    return { ok: true, rebuilt: await this.rebuildNodes(affected) };
  }

  private async validateInboundIds(body: Raw): Promise<string[] | undefined> {
    if (!has(body, "inboundIds")) return undefined;
    if (!Array.isArray(body.inboundIds)) bad("inboundIds: ожидается массив uuid");
    const ids = [...new Set((body.inboundIds as unknown[]).map((v) => requireUuid(String(v), "inboundIds")))];
    if (ids.length === 0) return [];

    const found = await this.db
      .select({ id: schema.inbound.id })
      .from(schema.inbound)
      .where(and(eq(schema.inbound.orgId, this.org), inArray(schema.inbound.id, ids)));
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length > 0) bad(`inboundIds: не найдены ${missing.join(", ")}`);
    return ids;
  }

  private async squadInboundIds(squadId: string): Promise<string[]> {
    const rows = await this.db
      .select({ inboundId: schema.squadInbound.inboundId })
      .from(schema.squadInbound)
      .where(eq(schema.squadInbound.squadId, squadId));
    return rows.map((r) => r.inboundId);
  }

  /** Состав squad'а = кто попадёт в клиенты inbound'а на ноде, поэтому правка требует пересборки. */
  private async setSquadInbounds(squadId: string, inboundIds: string[]): Promise<RebuildInfo[]> {
    const before = await this.squadInboundIds(squadId);

    await this.db.transaction(async (tx) => {
      await tx.delete(schema.squadInbound).where(eq(schema.squadInbound.squadId, squadId));
      if (inboundIds.length > 0) {
        await tx.insert(schema.squadInbound).values(inboundIds.map((inboundId) => ({ squadId, inboundId })));
      }
    });

    return this.rebuildNodes(await this.nodesByInboundIds([...new Set([...before, ...inboundIds])]));
  }

  // --- импорт: upsert по натуральному ключу ----------------------------------

  /**
   * Точка входа импортёра с чужой панели. Отдельные методы, а не флаг у create*,
   * потому что разница ровно одна и она принципиальная: оператор, заводящий второй
   * сервер с тем же hostname, ошибся и должен увидеть 409, а импортёр на втором
   * прогоне обязан ту же строку обновить. Всё остальное — та же валидация и та же
   * пересборка desired-state, поэтому писать в эти таблицы мимо InfraService нельзя.
   *
   * Сопоставление держится на индексах БД, не на предварительном SELECT: повторный
   * импорт штатно гоняется несколько раз подряд, а между «проверил» и «вставил»
   * есть гонка с админкой.
   *
   * Обновляется при этом ТОЛЬКО то, что вызывающий реально прислал (`providedOnly`).
   * Панель не знает про ssh_ref, capabilities, base_json, params, reality_privkey_ref
   * и tag_prefix — их заводит оператор или энроллмент агента уже ПОСЛЕ первого
   * прогона, и второй прогон не имеет права вернуть их к дефолту: пропажа ssh_ref
   * или tag_prefix «front» не падает, а тихо ломает следующий шаг cutover'а.
   */
  async upsertServer(body: Raw): Promise<Upserted<typeof schema.server.$inferSelect>> {
    const values = this.serverValues(body);

    const before = await this.db
      .select({ id: schema.server.id })
      .from(schema.server)
      .where(and(eq(schema.server.orgId, this.org), eq(schema.server.hostname, values.hostname)))
      .limit(1);

    const { orgId: _org, hostname: _hostname, ...mutable } = values;
    const [row] = await this.db
      .insert(schema.server)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.server.orgId, schema.server.hostname],
        set: providedOnly(body, mutable, ["primaryIp"]),
      })
      .returning();
    return { row, created: before.length === 0 };
  }

  async upsertConfigProfile(body: Raw): Promise<Upserted<typeof schema.configProfile.$inferSelect>> {
    const name = str(body, "name", { required: true, max: 128 })!;
    const baseJson = obj(body, "baseJson") ?? {};

    const before = await this.db
      .select({ id: schema.configProfile.id })
      .from(schema.configProfile)
      .where(and(eq(schema.configProfile.orgId, this.org), eq(schema.configProfile.name, name)))
      .limit(1);

    const [row] = await this.db
      .insert(schema.configProfile)
      .values({ orgId: this.org, name, baseJson })
      // без baseJson в запросе set пуст, а drizzle требует непустой: пишем имя
      // в самоё себя — строка не меняется, но RETURNING отдаёт существующую
      .onConflictDoUpdate({
        target: [schema.configProfile.orgId, schema.configProfile.name],
        set: has(body, "baseJson") ? { baseJson } : { name },
      })
      .returning();
    return { row, created: before.length === 0 };
  }

  /**
   * Ключ ноды — её config-профиль (node_config_profile_uq). Имя ключом быть не может:
   * ноду в панели переименовывают, и импорт завёл бы вторую вместо переименования
   * первой — а вторая уже не влезла бы в тот же профиль.
   */
  async upsertNode(body: Raw): Promise<Upserted<typeof schema.node.$inferSelect>> {
    const values = await this.nodeValues(body);

    const before = await this.db
      .select({ id: schema.node.id })
      .from(schema.node)
      .where(eq(schema.node.configProfileId, values.configProfileId))
      .limit(1);

    // status при обновлении не трогаем: его ставит отчёт агента (node-state.report),
    // и повторный импорт не должен откатывать взятую ноду обратно в provisioning
    const { orgId: _org, configProfileId: _profile, status: _status, ...mutable } = values;
    const [row] = await this.db
      .insert(schema.node)
      .values(values)
      .onConflictDoUpdate({
        target: schema.node.configProfileId,
        set: providedOnly(body, mutable, ["serverId", "name"]),
      })
      .returning();

    return { row, created: before.length === 0, rebuilt: await this.rebuildNodes([row.id]) };
  }

  async upsertInbound(body: Raw): Promise<Upserted<typeof schema.inbound.$inferSelect>> {
    const values = { ...(await this.inboundValues(body)), rawJson: obj(body, "rawJson") ?? null };
    assertInboundShape(values);

    const before = await this.db
      .select({ id: schema.inbound.id })
      .from(schema.inbound)
      .where(and(eq(schema.inbound.configProfileId, values.configProfileId), eq(schema.inbound.tag, values.tag)))
      .limit(1);

    const { orgId: _org, configProfileId: _profile, tag: _tag, ...mutable } = values;
    const [row] = await this.db
      .insert(schema.inbound)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.inbound.configProfileId, schema.inbound.tag],
        set: providedOnly(body, mutable, ["port"]),
      })
      .returning();

    return {
      row,
      created: before.length === 0,
      rebuilt: await this.rebuildProfileNodes(values.configProfileId),
    };
  }

  async upsertHost(body: Raw): Promise<Upserted<typeof schema.host.$inferSelect>> {
    const values = await this.hostValues(body);

    const before = await this.db
      .select({ id: schema.host.id })
      .from(schema.host)
      .where(
        and(
          eq(schema.host.inboundId, values.inboundId),
          eq(schema.host.address, values.address),
          eq(schema.host.port, values.port),
        ),
      )
      .limit(1);

    const { orgId: _org, inboundId: _inbound, address: _address, port: _port, ...mutable } = values;
    const [row] = await this.db
      .insert(schema.host)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.host.inboundId, schema.host.address, schema.host.port],
        set: providedOnly(body, mutable, ["nodeId"]),
      })
      .returning();

    return { row, created: before.length === 0, rebuilt: await this.rebuildCascadeRelays(values.nodeId) };
  }

  // --- пересборка ------------------------------------------------------------

  private async nodesByInboundIds(inboundIds: string[]): Promise<string[]> {
    if (inboundIds.length === 0) return [];
    const rows = await this.db
      .select({ nodeId: schema.node.id })
      .from(schema.inbound)
      .innerJoin(schema.node, eq(schema.node.configProfileId, schema.inbound.configProfileId))
      .where(and(eq(schema.inbound.orgId, this.org), inArray(schema.inbound.id, inboundIds)));
    return [...new Set(rows.map((r) => r.nodeId))];
  }

  private async rebuildProfileNodes(configProfileId: string): Promise<RebuildInfo[]> {
    const rows = await this.db
      .select({ id: schema.node.id })
      .from(schema.node)
      .where(and(eq(schema.node.orgId, this.org), eq(schema.node.configProfileId, configProfileId)));
    return this.rebuildNodes(rows.map((r) => r.id));
  }

  /**
   * Пересборка после правки host'а. В конфиг СВОЕЙ ноды host не входит вовсе — из него
   * собирается outbound на relay'е, который ходит на эту ноду как на exit. Клиентская
   * выдача читает host на каждый запрос (в подписке ничего не кешируется), пересобирать
   * там нечего.
   */
  private async rebuildCascadeRelays(exitNodeId: string): Promise<RebuildInfo[]> {
    const relays = await this.db
      .select({ relayNodeId: schema.cascadeLink.relayNodeId })
      .from(schema.cascadeLink)
      .where(and(eq(schema.cascadeLink.orgId, this.org), eq(schema.cascadeLink.exitNodeId, exitNodeId)));
    const ids = relays.map((r) => r.relayNodeId).filter((id): id is string => Boolean(id));
    return this.rebuildNodes(ids);
  }

  private async rebuildNodes(nodeIds: string[]): Promise<RebuildInfo[]> {
    const out: RebuildInfo[] = [];
    for (const nodeId of [...new Set(nodeIds)]) {
      const [row] = await this.db
        .select({ name: schema.node.name })
        .from(schema.node)
        .where(eq(schema.node.id, nodeId))
        .limit(1);
      const result = await this.state.rebuild(nodeId);
      out.push({ nodeId, name: row?.name ?? nodeId, version: result.version, changed: result.changed });
    }
    if (out.some((r) => r.changed)) {
      this.log.log(`правка сети: пересобрано нод ${out.filter((r) => r.changed).length} из ${out.length}`);
    }
    return out;
  }

  // --- общее -----------------------------------------------------------------

  private async assertServerExists(id: string): Promise<void> {
    const rows = await this.db
      .select({ id: schema.server.id })
      .from(schema.server)
      .where(and(eq(schema.server.orgId, this.org), eq(schema.server.id, id)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException(`сервер ${id} не найден`);
  }

  private async assertConfigProfileExists(id: string): Promise<void> {
    const rows = await this.db
      .select({ id: schema.configProfile.id })
      .from(schema.configProfile)
      .where(and(eq(schema.configProfile.orgId, this.org), eq(schema.configProfile.id, id)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException(`config-профиль ${id} не найден`);
  }

  private async assertInboundExists(id: string): Promise<void> {
    const rows = await this.db
      .select({ id: schema.inbound.id })
      .from(schema.inbound)
      .where(and(eq(schema.inbound.orgId, this.org), eq(schema.inbound.id, id)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException(`inbound ${id} не найден`);
  }

  private async assertNodeExists(id: string): Promise<void> {
    const rows = await this.db
      .select({ id: schema.node.id })
      .from(schema.node)
      .where(and(eq(schema.node.orgId, this.org), eq(schema.node.id, id)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException(`нода ${id} не найдена`);
  }

  private async assertSquadExists(id: string): Promise<void> {
    const rows = await this.db
      .select({ id: schema.squad.id })
      .from(schema.squad)
      .where(and(eq(schema.squad.orgId, this.org), eq(schema.squad.id, id)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException(`squad ${id} не найден`);
  }

  /** Ссылки на ноду разбросаны по таблицам без общей формы — считаем их одним сырым запросом. */
  private async refCount(query: ReturnType<typeof sql>, what: string): Promise<string[]> {
    const rows = (await this.db.execute(query)) as unknown as Array<{ n: number }>;
    const n = Number(rows[0]?.n ?? 0);
    return n > 0 ? [`${what} × ${n}`] : [];
  }
}

function hideServerSecrets(row: typeof schema.server.$inferSelect) {
  const { sshRef, ...rest } = row;
  return { ...rest, hasSshRef: Boolean(sshRef) };
}

function hideInboundSecrets(row: typeof schema.inbound.$inferSelect) {
  // raw_json — сырой ответ чужой панели при импорте, в нём встречается приватник Reality
  const { realityPrivkeyRef, rawJson, ...rest } = row;
  return { ...rest, hasRealityPrivkeyRef: Boolean(realityPrivkeyRef) };
}

function profileTakenError(configProfileId: string): ConflictException {
  return new ConflictException(
    `config-профиль ${configProfileId} уже занят другой нодой: Reality-идентичность живёт на inbound'ах профиля, ` +
      "и вторая нода затрёт ключи первой своим энроллментом. Заведите отдельный профиль",
  );
}

/**
 * Поля для conflict-set: только реально присланные вызывающим плюс `always`.
 * Разница с `compact` в источнике истины: там undefined уже отфильтрован валидатором,
 * а здесь значения уже подставлены дефолтами, и «не прислали» надо смотреть по body —
 * иначе обновление затирает дефолтом то, чего вызывающий не касался.
 */
function providedOnly<T extends Record<string, unknown>>(
  body: Raw,
  values: T,
  always: Array<keyof T> = [],
): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(values) as Array<keyof T>) {
    if (always.includes(key) || has(body, key as string)) out[key] = values[key];
  }
  return out;
}

/** Оставляет только присланные поля: undefined в drizzle .set() ничего не затирает, но и не значит. */
function compact<T extends Record<string, unknown>>(values: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined) out[k] = v;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

function assertNotEmpty(values: Record<string, unknown>): void {
  if (Object.keys(values).length === 0) bad("нечего обновлять: ни одного известного поля");
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

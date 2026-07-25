import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import {
  buildNodeConfig,
  configHash,
  deterministicUuid,
  type CascadeOutbound,
  type NodeInbound,
  type NodeUser,
} from "@vpn/xray-config";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";

const CASCADE_UUID_NS = "gavy-vpn-cascade";

/**
 * Сборка desired-state ноды из модели БД.
 * Генератор детерминирован: повторная сборка без изменений даёт тот же config_hash,
 * агент видит совпадение и не трогает Xray (no-op вместо лишнего рестарта).
 */
@Injectable()
export class NodeStateService {
  private readonly log = new Logger(NodeStateService.name);
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  /** Пересобирает desired-state и повышает версию, только если конфиг реально изменился. */
  async rebuild(nodeId: string) {
    const node = await this.getNode(nodeId);

    const inboundRows = await this.db
      .select()
      .from(schema.inbound)
      .where(eq(schema.inbound.configProfileId, node.configProfileId));

    const inbounds: NodeInbound[] = inboundRows.map((i) => ({
      tag: i.tag,
      port: i.port,
      role: (node.roles[0] ?? "exit") as NodeInbound["role"],
      flow: i.flow,
      network: i.network,
      reality: {
        publicKey: i.realityPublicKey ?? "",
        shortIds: i.shortIds.length > 0 ? i.shortIds : [""],
        sni: i.sni ?? "",
        fingerprint: i.fingerprint ?? "firefox",
      },
    }));

    const users = await this.collectUsers(node, inboundRows);
    const cascades = await this.collectCascades(nodeId, inboundRows);

    const config = buildNodeConfig({
      role: (node.roles[0] ?? "exit") as NodeInbound["role"],
      inbounds,
      users,
      cascades,
    });
    const hash = configHash(config);

    const [existing] = await this.db
      .select()
      .from(schema.nodeDesiredState)
      .where(eq(schema.nodeDesiredState.nodeId, nodeId))
      .limit(1);

    if (existing?.configHash === hash) return { changed: false, version: existing.version, hash };

    const version = (existing?.version ?? 0) + 1;
    const payload = {
      nodeId,
      version,
      configHash: hash,
      config,
      users: users.map((u) => ({ email: u.email, uuid: u.uuid, level: u.level ?? 0 })),
      generatedAt: new Date(),
    };

    if (existing) {
      await this.db.update(schema.nodeDesiredState).set(payload).where(eq(schema.nodeDesiredState.nodeId, nodeId));
    } else {
      await this.db.insert(schema.nodeDesiredState).values(payload);
    }
    await this.db.update(schema.node).set({ desiredConfigVersion: version }).where(eq(schema.node.id, nodeId));

    this.log.log(`node ${node.name}: desired-state v${version} (${hash.slice(0, 12)})`);
    return { changed: true, version, hash };
  }

  /**
   * Пересборка всех нод org. Дёшево: rebuild не поднимает версию, если конфиг не изменился,
   * поэтому это безопасно гонять по расписанию как safety-net.
   */
  async rebuildAll(): Promise<{ total: number; changed: string[]; failed: string[] }> {
    const nodes = await this.db
      .select({ id: schema.node.id, name: schema.node.name })
      .from(schema.node)
      .where(eq(schema.node.orgId, this.cfg.defaultOrgId));

    const changed: string[] = [];
    const failed: string[] = [];
    for (const n of nodes) {
      try {
        const result = await this.rebuild(n.id);
        if (result.changed) changed.push(n.id);
      } catch (err) {
        failed.push(n.id);
        this.log.error(`node ${n.name}: пересборка не удалась — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { total: nodes.length, changed, failed };
  }

  async getDesiredState(nodeId: string): Promise<typeof schema.nodeDesiredState.$inferSelect> {
    const existing = await this.loadState(nodeId);
    if (existing) return existing;

    // первый запрос агента после регистрации — состояния ещё нет, собираем на лету
    await this.rebuild(nodeId);
    const built = await this.loadState(nodeId);
    if (!built) throw new NotFoundException(`не удалось собрать desired-state для ноды ${nodeId}`);
    return built;
  }

  private async loadState(nodeId: string) {
    const [state] = await this.db
      .select()
      .from(schema.nodeDesiredState)
      .where(eq(schema.nodeDesiredState.nodeId, nodeId))
      .limit(1);
    return state ?? null;
  }

  /** Отчёт агента: что реально применено. По нему же активируются каскады. */
  async report(
    nodeId: string,
    input: { appliedConfigHash?: string; agentVersion?: string; xrayVersion?: string; sysStats?: Record<string, unknown>; egressHealth?: Record<string, unknown> },
  ) {
    const values = {
      nodeId,
      appliedConfigHash: input.appliedConfigHash,
      agentVersion: input.agentVersion,
      xrayVersion: input.xrayVersion,
      sysStats: input.sysStats ?? {},
      egressHealth: input.egressHealth ?? {},
      heartbeatAt: new Date(),
    };
    const [existing] = await this.db
      .select()
      .from(schema.nodeReportedState)
      .where(eq(schema.nodeReportedState.nodeId, nodeId))
      .limit(1);

    if (existing) {
      await this.db.update(schema.nodeReportedState).set(values).where(eq(schema.nodeReportedState.nodeId, nodeId));
    } else {
      await this.db.insert(schema.nodeReportedState).values(values);
    }

    await this.db
      .update(schema.node)
      .set({ observedConfigHash: input.appliedConfigHash ?? null, status: "active" })
      .where(eq(schema.node.id, nodeId));

    const node = await this.getNode(nodeId);
    await this.db
      .update(schema.server)
      .set({
        lastHeartbeatAt: new Date(),
        agentStatus: "online",
        agentVersion: input.agentVersion,
        xrayVersion: input.xrayVersion,
      })
      .where(eq(schema.server.id, node.serverId));

    return { ok: true };
  }

  /** Пользователи ноды: обычные подписчики через squad + служебные link-user каскадов. */
  private async collectUsers(
    node: typeof schema.node.$inferSelect,
    inboundRows: Array<typeof schema.inbound.$inferSelect>,
  ): Promise<NodeUser[]> {
    const inboundIds = inboundRows.map((i) => i.id);
    if (inboundIds.length === 0) return [];

    const squadLinks = await this.db
      .select()
      .from(schema.squadInbound)
      .where(inArray(schema.squadInbound.inboundId, inboundIds));

    const users: NodeUser[] = [];
    if (squadLinks.length > 0) {
      const squadIds = [...new Set(squadLinks.map((s) => s.squadId))];
      const subs = await this.db
        .select({ sub: schema.subscription })
        .from(schema.subscriptionSquad)
        .innerJoin(schema.subscription, eq(schema.subscriptionSquad.subscriptionId, schema.subscription.id))
        .where(inArray(schema.subscriptionSquad.squadId, squadIds));

      for (const { sub } of subs) {
        // истёкшие и отключённые на ноду не выгружаются — это и есть отключение доступа
        if (sub.status !== "active" && sub.status !== "trial") continue;
        if (sub.expireAt && sub.expireAt < new Date()) continue;
        for (const link of squadLinks) {
          const inbound = inboundRows.find((i) => i.id === link.inboundId);
          if (inbound) users.push({ email: sub.shortUuid, uuid: sub.vlessUuid, inboundTag: inbound.tag });
        }
      }
    }

    // link-user'ы: relay представлен на exit'е служебным аккаунтом
    const links = await this.db
      .select()
      .from(schema.cascadeLink)
      .where(and(eq(schema.cascadeLink.orgId, this.cfg.defaultOrgId), eq(schema.cascadeLink.exitNodeId, node.id)));

    for (const link of links) {
      const inbound = inboundRows.find((i) => i.tag === link.exitInboundTag);
      if (!inbound) continue;
      users.push({
        email: `cascade:${link.cc.toLowerCase()}:${link.id.slice(0, 8)}`,
        uuid: link.linkUserUuid,
        inboundTag: inbound.tag,
      });
    }

    return users;
  }

  /** Плечо каскада на стороне relay: outbound на exit + правило форварда. */
  private async collectCascades(
    nodeId: string,
    inboundRows: Array<typeof schema.inbound.$inferSelect>,
  ): Promise<CascadeOutbound[]> {
    const links = await this.db
      .select()
      .from(schema.cascadeLink)
      .where(
        and(
          eq(schema.cascadeLink.orgId, this.cfg.defaultOrgId),
          eq(schema.cascadeLink.relayNodeId, nodeId),
          eq(schema.cascadeLink.kind, "server_forward"),
        ),
      );

    const out: CascadeOutbound[] = [];
    for (const link of links) {
      const [exitHost] = await this.db
        .select({ host: schema.host, inbound: schema.inbound })
        .from(schema.host)
        .innerJoin(schema.inbound, eq(schema.host.inboundId, schema.inbound.id))
        .where(and(eq(schema.host.nodeId, link.exitNodeId), eq(schema.inbound.tag, link.exitInboundTag)))
        .limit(1);
      if (!exitHost) continue;

      const relayInbound = inboundRows[0];
      if (!relayInbound) continue;

      out.push({
        tag: `CASCADE_${link.cc.toUpperCase()}`,
        cc: link.cc,
        fromInboundTag: relayInbound.tag,
        exit: {
          address: exitHost.host.address,
          port: exitHost.host.port,
          uuid: link.linkUserUuid,
          flow: exitHost.host.flow ?? "xtls-rprx-vision",
          reality: {
            publicKey: exitHost.host.pbk ?? "",
            shortIds: [exitHost.host.sid ?? ""],
            sni: exitHost.host.sni ?? "",
            fingerprint: exitHost.host.fingerprint ?? "firefox",
          },
        },
      });
    }
    return out;
  }

  /** Детерминированный uuid служебного пользователя каскада. */
  static linkUserUuid(cascadeLinkId: string): string {
    return deterministicUuid(CASCADE_UUID_NS, cascadeLinkId);
  }

  private async getNode(nodeId: string) {
    const [node] = await this.db
      .select()
      .from(schema.node)
      .where(and(eq(schema.node.orgId, this.cfg.defaultOrgId), eq(schema.node.id, nodeId)))
      .limit(1);
    if (!node) throw new NotFoundException(`нода ${nodeId} не найдена`);
    return node;
  }
}

import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import type { ChannelInput, DomainList, FrontOutbound, GeneratorInput, ProfileInput } from "@vpn/xray-config";
import { DB } from "../db/db.module.js";

export interface SubscriptionBundle {
  subscription: typeof schema.subscription.$inferSelect;
  input: GeneratorInput;
  profiles: ProfileInput[];
}

@Injectable()
export class SubscriptionRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async findByShortUuid(orgId: string, shortUuid: string) {
    const rows = await this.db
      .select()
      .from(schema.subscription)
      .where(and(eq(schema.subscription.orgId, orgId), eq(schema.subscription.shortUuid, shortUuid)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findById(orgId: string, id: string) {
    const rows = await this.db
      .select()
      .from(schema.subscription)
      .where(and(eq(schema.subscription.orgId, orgId), eq(schema.subscription.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Собирает вход генератора: каналы+хосты, профили+tier'ы, front, список РФ-доменов. */
  async loadBundle(
    orgId: string,
    subscription: typeof schema.subscription.$inferSelect,
  ): Promise<SubscriptionBundle | null> {
    const channels = await this.loadChannels(orgId);
    const profiles = await this.loadProfiles(orgId);
    if (channels.length === 0 || profiles.length === 0) return null;

    const input: GeneratorInput = {
      vlessUuid: subscription.vlessUuid,
      channels,
      front: await this.loadFront(orgId),
      domainList: await this.loadDomainList(orgId),
    };
    return { subscription, input, profiles };
  }

  private async loadChannels(orgId: string): Promise<ChannelInput[]> {
    const rows = await this.db
      .select({ ch: schema.channel, host: schema.host })
      .from(schema.channel)
      .leftJoin(schema.host, eq(schema.channel.hostId, schema.host.id))
      .where(eq(schema.channel.orgId, orgId));

    return rows
      .filter((r) => r.host)
      .map(({ ch, host }) => ({
        kind: ch.kind as "direct" | "cascade",
        tag: ch.newTag ?? ch.tag,
        cc: ch.cc ?? undefined,
        host: hostRef(host!),
      }));
  }

  private async loadProfiles(orgId: string): Promise<ProfileInput[]> {
    const profs = await this.db
      .select()
      .from(schema.profile)
      .where(eq(schema.profile.orgId, orgId))
      .orderBy(schema.profile.sortOrder);

    const pcs = await this.db
      .select({ pc: schema.profileChannel, ch: schema.channel })
      .from(schema.profileChannel)
      .innerJoin(schema.channel, eq(schema.profileChannel.channelId, schema.channel.id))
      .where(eq(schema.profileChannel.orgId, orgId));

    return profs.map((p) => {
      const mine = pcs.filter((x) => x.pc.profileId === p.id);
      const tag = (x: (typeof mine)[number]) => x.ch.newTag ?? x.ch.tag;
      return {
        remark: p.remark,
        isAuto: p.isAuto,
        primary: mine.filter((x) => x.pc.tier === 1).sort(bySort).map(tag),
        fallback: mine.filter((x) => x.pc.tier === 2).sort(bySort).map(tag),
      };
    });
  }

  private async loadFront(orgId: string): Promise<FrontOutbound | undefined> {
    const rows = await this.db
      .select()
      .from(schema.host)
      .where(and(eq(schema.host.orgId, orgId), eq(schema.host.tagPrefix, "front")))
      .limit(1);
    const h = rows[0];
    if (!h) return undefined;
    return { tag: "front", host: hostRef(h) };
  }

  private async loadDomainList(orgId: string): Promise<DomainList> {
    const lists = await this.db
      .select()
      .from(schema.routingDomainList)
      .where(eq(schema.routingDomainList.orgId, orgId))
      .orderBy(desc(schema.routingDomainList.version))
      .limit(1);
    const list = lists[0];
    if (!list) return { zones: [], domains: [] };

    const entries = await this.db
      .select()
      .from(schema.routingDomainEntry)
      .where(eq(schema.routingDomainEntry.listId, list.id));

    const domains: string[] = [];
    const ipCidrs: string[] = [];
    for (const e of entries) {
      if (e.kind === "cidr") ipCidrs.push(e.value);
      else if (e.kind === "regexp") domains.push(`regexp:${e.value}`);
      else if (e.kind === "full") domains.push(`full:${e.value}`);
      else domains.push(`domain:${e.value}`);
    }
    return { zones: [], domains, ipCidrs };
  }
}

function bySort(a: { pc: { sortOrder: number } }, b: { pc: { sortOrder: number } }): number {
  return a.pc.sortOrder - b.pc.sortOrder;
}

function hostRef(h: typeof schema.host.$inferSelect) {
  return {
    address: h.address,
    port: h.port,
    sni: h.sni ?? "",
    fingerprint: h.fingerprint ?? "firefox",
    pbk: h.pbk ?? "",
    sid: h.sid ?? "",
    flow: h.flow ?? "xtls-rprx-vision",
    network: "tcp",
  };
}

import { Inject, Injectable, Logger } from "@nestjs/common";
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
  private readonly log = new Logger(SubscriptionRepository.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  async findByShortUuid(
    orgId: string,
    shortUuid: string,
  ): Promise<typeof schema.subscription.$inferSelect | null> {
    const rows = await this.db
      .select()
      .from(schema.subscription)
      .where(and(eq(schema.subscription.orgId, orgId), eq(schema.subscription.shortUuid, shortUuid)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Легаси-путь `/api/sub/<id>`. У мигрируемых с Remnawave клиентов в сохранённых
   * ссылках стоит shortUuid, а не наш внутренний PK, поэтому сначала пробуем
   * shortUuid и только потом id — иначе в момент переключения вся легаси-база
   * молча получит заглушку «подписка не найдена».
   */
  async findById(orgId: string, id: string) {
    const byShortUuid = await this.findByShortUuid(orgId, id);
    if (byShortUuid) return byShortUuid;

    // внутренний PK — uuid; на произвольной строке Postgres бросит ошибку типа
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;

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
    const profiles = await this.loadProfiles(orgId, new Set(channels.map((c) => c.tag)));
    if (channels.length === 0 || profiles.length === 0) return null;

    const input: GeneratorInput = {
      vlessUuid: subscription.vlessUuid,
      channels,
      front: await this.loadFront(orgId),
      domainList: await this.loadDomainList(orgId),
    };
    return { subscription, input, profiles };
  }

  /**
   * Каналы, которые допустимо показывать клиенту прямо сейчас.
   * Отсекаем: хост без записи, выключенный/скрытый хост и каскад, у которого
   * не обе ноды применили конфиг (иначе балансер уведёт трафик в полу-собранную
   * цепочку — чёрную дыру без единого сообщения клиенту).
   */
  private async loadChannels(orgId: string): Promise<ChannelInput[]> {
    const rows = await this.db
      .select({ ch: schema.channel, host: schema.host, link: schema.cascadeLink })
      .from(schema.channel)
      .leftJoin(schema.host, eq(schema.channel.hostId, schema.host.id))
      .leftJoin(schema.cascadeLink, eq(schema.channel.cascadeLinkId, schema.cascadeLink.id))
      .where(
        and(
          eq(schema.channel.orgId, orgId),
          eq(schema.host.isDisabled, false),
          eq(schema.host.isHidden, false),
        ),
      );

    return rows
      .filter((r) => r.host)
      // канал без привязки к каскаду — обычный direct, его не отсекаем
      .filter((r) => !r.ch.cascadeLinkId || r.link?.status === "active")
      .map(({ ch, host }) => ({
        kind: ch.kind as "direct" | "cascade",
        tag: ch.newTag ?? ch.tag,
        cc: ch.cc ?? undefined,
        host: hostRef(host!),
      }));
  }

  /**
   * Профили собираются ТОЛЬКО из фактически доступных каналов.
   * Если строить их независимо, отфильтрованный выше канал остался бы в профиле,
   * генератор бросил бы «channel not found» — и выдача легла бы у всей базы
   * из-за одного неактивного каскада.
   * Профиль, у которого не осталось каналов, выбрасываем целиком: балансер
   * с пустым селектором — это клиент без интернета и без сообщения об ошибке.
   */
  private async loadProfiles(orgId: string, availableTags: Set<string>): Promise<ProfileInput[]> {
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

    const profiles: ProfileInput[] = [];
    for (const p of profs) {
      const mine = pcs.filter((x) => x.pc.profileId === p.id);
      const tag = (x: (typeof mine)[number]) => x.ch.newTag ?? x.ch.tag;
      const pick = (tier: number) =>
        mine
          .filter((x) => x.pc.tier === tier)
          .sort(bySort)
          .map(tag)
          .filter((t) => availableTags.has(t));

      const primary = pick(1);
      const fallback = pick(2);
      if (primary.length === 0 && fallback.length === 0) {
        this.log.warn(`профиль «${p.remark}» пропущен: не осталось доступных каналов`);
        continue;
      }
      // если пуст только primary — поднимаем fallback, чтобы не остаться без tier1
      profiles.push({
        remark: p.remark,
        isAuto: p.isAuto,
        ruSplit: p.ruSplit,
        primary: primary.length > 0 ? primary : fallback,
        fallback: primary.length > 0 ? fallback : [],
      });
    }
    return profiles;
  }

  private async loadFront(orgId: string): Promise<FrontOutbound | undefined> {
    const rows = await this.db
      .select()
      .from(schema.host)
      .where(
        and(
          eq(schema.host.orgId, orgId),
          eq(schema.host.tagPrefix, "front"),
          eq(schema.host.isDisabled, false),
        ),
      )
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

import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { schema, type Database } from "@corelink/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { LINK_CODE_ALPHABET } from "./attribution.service.js";

const CODE_LENGTH = 6;
const CODE_ATTEMPTS = 5;

@Injectable()
export class CampaignService {
  private readonly cfg = loadConfig();

  constructor(@Inject(DB) private readonly db: Database) {}

  async list() {
    const campaigns = await this.db
      .select()
      .from(schema.campaign)
      .where(eq(schema.campaign.orgId, this.cfg.defaultOrgId))
      .orderBy(desc(schema.campaign.createdAt));

    const links = await this.db
      .select()
      .from(schema.campaignLink)
      .where(eq(schema.campaignLink.orgId, this.cfg.defaultOrgId));

    return campaigns.map((c) => ({
      ...c,
      links: links.filter((l) => l.campaignId === c.id),
    }));
  }

  async create(input: { slug: string; name: string; channel?: string; costKopeks?: number }) {
    const [row] = await this.db
      .insert(schema.campaign)
      .values({
        orgId: this.cfg.defaultOrgId,
        slug: input.slug,
        name: input.name,
        channel: input.channel,
        costKopeks: input.costKopeks ?? 0,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new ConflictException(`кампания со slug ${input.slug} уже есть`);
    return row;
  }

  async update(
    id: string,
    patch: { name?: string; channel?: string; status?: string; costKopeks?: number },
  ) {
    const values: Record<string, unknown> = {};
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.channel !== undefined) values.channel = patch.channel;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.costKopeks !== undefined) values.costKopeks = patch.costKopeks;
    if (Object.keys(values).length === 0) return this.getCampaign(id);

    const [row] = await this.db
      .update(schema.campaign)
      .set(values)
      .where(and(eq(schema.campaign.orgId, this.cfg.defaultOrgId), eq(schema.campaign.id, id)))
      .returning();
    if (!row) throw new NotFoundException(`кампания ${id} не найдена`);
    return row;
  }

  /** Код генерится случайно; коллизию ловит campaign_link_code_uq, а не проверка перед вставкой. */
  async createLink(campaignId: string, label?: string) {
    await this.getCampaign(campaignId);

    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      const inserted = await this.db
        .insert(schema.campaignLink)
        .values({
          orgId: this.cfg.defaultOrgId,
          campaignId,
          code: randomCode(),
          label,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length > 0) return { ...inserted[0], startPayload: `c_${inserted[0].code}` };
    }
    throw new ConflictException(`не удалось подобрать свободный код за ${CODE_ATTEMPTS} попыток`);
  }

  /** Счётчики в campaign_link денормализованы для UI; здесь считаем по campaign_event — источнику истины. */
  async stats(campaignId: string) {
    const campaign = await this.getCampaign(campaignId);

    const rows = await this.db
      .select({
        link: schema.campaignLink,
        registrations: sql<string>`count(*) filter (where ${schema.campaignEvent.type} = 'registration')`,
        payments: sql<string>`count(*) filter (where ${schema.campaignEvent.type} = 'payment')`,
        payingUsers: sql<string>`count(distinct ${schema.campaignEvent.subscriberId}) filter (where ${schema.campaignEvent.type} = 'payment')`,
        revenueKopeks: sql<string>`coalesce(sum((${schema.campaignEvent.meta} ->> 'amountKopeks')::bigint) filter (where ${schema.campaignEvent.type} = 'payment'), 0)`,
      })
      .from(schema.campaignLink)
      .leftJoin(schema.campaignEvent, eq(schema.campaignEvent.campaignLinkId, schema.campaignLink.id))
      .where(
        and(eq(schema.campaignLink.orgId, this.cfg.defaultOrgId), eq(schema.campaignLink.campaignId, campaignId)),
      )
      .groupBy(schema.campaignLink.id);

    const links = rows.map(({ link, ...agg }) => ({
      id: link.id,
      code: link.code,
      label: link.label,
      isArchived: link.isArchived,
      registrations: Number(agg.registrations),
      payments: Number(agg.payments),
      payingUsers: Number(agg.payingUsers),
      revenueKopeks: Number(agg.revenueKopeks),
    }));

    const total = links.reduce(
      (acc, l) => ({
        registrations: acc.registrations + l.registrations,
        payingUsers: acc.payingUsers + l.payingUsers,
        revenueKopeks: acc.revenueKopeks + l.revenueKopeks,
      }),
      { registrations: 0, payingUsers: 0, revenueKopeks: 0 },
    );

    return {
      campaign,
      links,
      total: {
        ...total,
        costKopeks: campaign.costKopeks,
        profitKopeks: total.revenueKopeks - campaign.costKopeks,
        conversion: total.registrations > 0 ? Number((total.payingUsers / total.registrations).toFixed(4)) : 0,
        cpaKopeks: total.payingUsers > 0 ? Math.round(campaign.costKopeks / total.payingUsers) : null,
      },
    };
  }

  private async getCampaign(id: string) {
    const rows = await this.db
      .select()
      .from(schema.campaign)
      .where(and(eq(schema.campaign.orgId, this.cfg.defaultOrgId), eq(schema.campaign.id, id)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException(`кампания ${id} не найдена`);
    return row;
  }
}

function randomCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += LINK_CODE_ALPHABET[randomInt(LINK_CODE_ALPHABET.length)];
  return code;
}

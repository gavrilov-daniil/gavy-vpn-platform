import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { LedgerService } from "../payments/ledger.service.js";
import { AttributionService } from "../crm/attribution.service.js";

/** Неугадываемый идентификатор подписки в публичном URL. */
function generateShortUuid(): string {
  return randomBytes(12).toString("hex");
}

@Injectable()
export class SubscribersService {
  private readonly log = new Logger(SubscribersService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly ledger: LedgerService,
    private readonly attribution: AttributionService,
  ) {}

  /**
   * Точка входа из бота: найти подписчика по Telegram id или создать.
   * Атрибуция first-touch: campaign_link_id пишется только при создании
   * и больше никогда не перезаписывается.
   */
  async resolve(input: {
    telegramId: number;
    username?: string;
    languageCode?: string;
    /** Сырой payload из t.me/bot?start=... — код кампании резолвится здесь. */
    startPayload?: string;
    campaignLinkId?: string;
    referrerSubscriberId?: string;
  }) {
    const [existing] = await this.db
      .select()
      .from(schema.subscriber)
      .where(
        and(
          eq(schema.subscriber.orgId, this.cfg.defaultOrgId),
          eq(schema.subscriber.telegramId, input.telegramId),
        ),
      )
      .limit(1);

    // код кампании из deep-link; невалидный payload не должен ломать регистрацию — просто органика
    const link = input.campaignLinkId
      ? { id: input.campaignLinkId }
      : await this.attribution.resolveStartPayload(input.startPayload);

    if (existing) {
      if (input.username && input.username !== existing.username) {
        await this.db
          .update(schema.subscriber)
          .set({ username: input.username })
          .where(eq(schema.subscriber.id, existing.id));
      }
      // повторный приход по ссылке: событие пишется, но first-touch не переписывается
      if (link) await this.attribution.onRegistration(existing.id, link.id);
      return { subscriber: existing, created: false };
    }

    const [created] = await this.db
      .insert(schema.subscriber)
      .values({
        orgId: this.cfg.defaultOrgId,
        telegramId: input.telegramId,
        username: input.username,
        languageCode: input.languageCode,
        // campaign_link_id НЕ пишем здесь: first-touch claim делает AttributionService
        // условным UPDATE по IS NULL. Если заполнить сразу, claim не сработает
        // и регистрация будет засчитана как повторный приход.
        referrerSubscriberId: input.referrerSubscriberId,
        status: "active",
      })
      .onConflictDoNothing()
      .returning();

    // гонка двух параллельных /start — второй запрос перечитывает созданную запись
    if (!created) {
      const [row] = await this.db
        .select()
        .from(schema.subscriber)
        .where(
          and(
            eq(schema.subscriber.orgId, this.cfg.defaultOrgId),
            eq(schema.subscriber.telegramId, input.telegramId),
          ),
        )
        .limit(1);
      return { subscriber: row, created: false };
    }

    await this.ensureSubscription(created.id);
    if (link) await this.attribution.onRegistration(created.id, link.id);
    return { subscriber: created, created: true };
  }

  /** У подписчика всегда есть запись подписки — она же держит идентичность в конфиге. */
  async ensureSubscription(subscriberId: string) {
    const [existing] = await this.db
      .select()
      .from(schema.subscription)
      .where(
        and(
          eq(schema.subscription.orgId, this.cfg.defaultOrgId),
          eq(schema.subscription.subscriberId, subscriberId),
        ),
      )
      .limit(1);
    if (existing) return existing;

    const [created] = await this.db
      .insert(schema.subscription)
      .values({
        orgId: this.cfg.defaultOrgId,
        subscriberId,
        shortUuid: generateShortUuid(),
        vlessUuid: randomUUID(),
        status: "inactive",
      })
      .returning();
    return created;
  }

  /** Сводка для главного экрана бота. */
  async overview(subscriberId: string) {
    const subscription = await this.ensureSubscription(subscriberId);
    const balance = await this.ledger.getBalance(subscriberId);
    const devices = await this.db
      .select({ count: sql<string>`count(*)` })
      .from(schema.subscriberDevice)
      .where(eq(schema.subscriberDevice.subscriptionId, subscription.id));

    const [lastPayment] = await this.db
      .select()
      .from(schema.payment)
      .where(
        and(eq(schema.payment.subscriberId, subscriberId), eq(schema.payment.status, "paid")),
      )
      .orderBy(desc(schema.payment.paidAt))
      .limit(1);

    const active = subscription.status === "active" && (!subscription.expireAt || subscription.expireAt > new Date());

    return {
      subscriptionId: subscription.id,
      status: subscription.status,
      active,
      expireAt: subscription.expireAt,
      subscriptionUrl: `https://${this.cfg.subPublicHost}/auto/${subscription.shortUuid}`,
      usedTrafficBytes: Number(subscription.usedTrafficBytes ?? 0),
      trafficLimitBytes: subscription.trafficLimitBytes ? Number(subscription.trafficLimitBytes) : null,
      deviceLimit: subscription.hwidDeviceLimit,
      devicesUsed: Number(devices[0]?.count ?? 0),
      balanceKopeks: balance,
      lastPaidAt: lastPayment?.paidAt ?? null,
    };
  }

  async listPlans() {
    return this.db
      .select()
      .from(schema.plan)
      .where(and(eq(schema.plan.orgId, this.cfg.defaultOrgId), eq(schema.plan.isActive, true)))
      .orderBy(schema.plan.sortOrder);
  }

  /** Для админки — включая выключенные тарифы. */
  async listAllPlans() {
    return this.db
      .select()
      .from(schema.plan)
      .where(eq(schema.plan.orgId, this.cfg.defaultOrgId))
      .orderBy(schema.plan.sortOrder);
  }

  async createPlan(input: {
    code: string;
    title: string;
    periodDays: number;
    priceKopeks: number;
    trafficGb?: number;
    deviceLimit?: number;
    isTrial?: boolean;
    sortOrder?: number;
    squadIds?: string[];
  }) {
    const [row] = await this.db
      .insert(schema.plan)
      .values({
        orgId: this.cfg.defaultOrgId,
        code: input.code,
        title: input.title,
        periodDays: input.periodDays,
        priceKopeks: input.priceKopeks,
        trafficGb: input.trafficGb,
        deviceLimit: input.deviceLimit,
        isTrial: input.isTrial ?? false,
        sortOrder: input.sortOrder ?? 0,
        squadIds: input.squadIds ?? [],
      })
      .returning();
    return row;
  }

  async updatePlan(
    planId: string,
    patch: {
      title?: string;
      periodDays?: number;
      priceKopeks?: number;
      trafficGb?: number | null;
      deviceLimit?: number | null;
      isActive?: boolean;
      isTrial?: boolean;
      sortOrder?: number;
      squadIds?: string[];
    },
  ) {
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) values[key] = value;
    }
    if (Object.keys(values).length === 0) throw new BadRequestException("нечего обновлять");

    const [row] = await this.db
      .update(schema.plan)
      .set(values)
      .where(and(eq(schema.plan.orgId, this.cfg.defaultOrgId), eq(schema.plan.id, planId)))
      .returning();
    if (!row) throw new NotFoundException("тариф не найден");
    return row;
  }

  /**
   * Активация триала. Выдаётся один раз на подписчика — отметка trial_used_at
   * ставится условным UPDATE, поэтому параллельные запросы не выдадут два триала.
   */
  async activateTrial(subscriberId: string) {
    const [plan] = await this.db
      .select()
      .from(schema.plan)
      .where(
        and(
          eq(schema.plan.orgId, this.cfg.defaultOrgId),
          eq(schema.plan.isTrial, true),
          eq(schema.plan.isActive, true),
        ),
      )
      .limit(1);
    if (!plan) throw new BadRequestException("триал не настроен");

    const claimed = await this.db
      .update(schema.subscriber)
      .set({ trialUsedAt: new Date() })
      .where(
        and(
          eq(schema.subscriber.id, subscriberId),
          sql`${schema.subscriber.trialUsedAt} is null`,
        ),
      )
      .returning();

    if (claimed.length === 0) throw new BadRequestException("триал уже использован");

    const subscription = await this.ensureSubscription(subscriberId);
    const expireAt = new Date(Date.now() + plan.periodDays * 86_400_000);

    await this.db
      .update(schema.subscription)
      .set({
        status: "trial",
        expireAt,
        trafficLimitBytes: plan.trafficGb ? plan.trafficGb * 1024 ** 3 : null,
        hwidDeviceLimit: plan.deviceLimit,
        updatedAt: new Date(),
      })
      .where(eq(schema.subscription.id, subscription.id));

    // без членства в squad'ах тарифа юзер не попадёт в desired-state ноды
    // и получит рабочий на вид конфиг, по которому Xray разорвёт хендшейк
    if (plan.squadIds.length > 0) {
      await this.db
        .insert(schema.subscriptionSquad)
        .values(plan.squadIds.map((squadId) => ({ subscriptionId: subscription.id, squadId })))
        .onConflictDoNothing();
    }

    this.log.log(`триал выдан подписчику ${subscriberId} до ${expireAt.toISOString()}`);
    return { ok: true, expireAt, subscriptionUrl: `https://${this.cfg.subPublicHost}/auto/${subscription.shortUuid}` };
  }

  async getById(subscriberId: string) {
    const [row] = await this.db
      .select()
      .from(schema.subscriber)
      .where(
        and(eq(schema.subscriber.orgId, this.cfg.defaultOrgId), eq(schema.subscriber.id, subscriberId)),
      )
      .limit(1);
    if (!row) throw new NotFoundException("подписчик не найден");
    return row;
  }
}

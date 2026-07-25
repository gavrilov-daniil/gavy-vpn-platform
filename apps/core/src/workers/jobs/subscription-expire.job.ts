import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { DB } from "../../db/db.module.js";
import { loadConfig } from "../../config.js";
import { NodeStateService } from "../../nodes/node-state.service.js";
import type { JobRunner } from "../job.types.js";

/** Стратегии сброса счётчика трафика, у которых есть период. no_reset не сбрасывается никогда. */
const RESET_STRATEGIES = ["month", "day"] as const;
type ResetStrategy = (typeof RESET_STRATEGIES)[number];

/**
 * Истечение подписок и лимит трафика. Идемпотентность — в самих условиях: второй прогон
 * уже никого не находит (истёкшие сменили статус, счётчик сброшен в текущем периоде).
 *
 * После смены статуса юзер обязан исчезнуть с нод: collectUsers выгружает только active|trial
 * с непросроченным expire_at, поэтому достаточно пересобрать desired-state. Пересобираем ВСЕ
 * ноды org: rebuild не поднимает версию, если конфиг не изменился, так что ноды без этих
 * пользователей не перезапустятся.
 */
@Injectable()
export class SubscriptionExpireJob implements JobRunner {
  readonly jobName = "subscription-expire" as const;
  private readonly log = new Logger(SubscriptionExpireJob.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly nodes: NodeStateService,
  ) {}

  async run() {
    const now = new Date();
    const expired = await this.db
      .update(schema.subscription)
      .set({ status: "expired", updatedAt: now })
      .where(
        and(
          eq(schema.subscription.orgId, this.cfg.defaultOrgId),
          inArray(schema.subscription.status, ["active", "trial"]),
          isNotNull(schema.subscription.expireAt),
          lt(schema.subscription.expireAt, now),
        ),
      )
      .returning({ id: schema.subscription.id });

    // сначала сброс по периоду, потом лимит: иначе подписка с наступившим новым периодом
    // сперва приостанавливалась, а следом тут же возвращалась в active
    let reset = 0;
    let restored = 0;
    for (const strategy of RESET_STRATEGIES) {
      // порядок внутри стратегии обратный: возврат смотрит на счётчик ДО обнуления
      restored += (await this.restoreAfterPeriod(strategy, now)).length;
      reset += (await this.resetPeriod(strategy, now)).length;
    }

    const suspended = await this.suspendOverLimit(now);

    const changedAccess = expired.length + reset + suspended.length;
    if (changedAccess === 0) {
      return { expired: 0, trafficReset: 0, trafficRestored: 0, trafficSuspended: 0, nodesTotal: 0, nodesChanged: 0, nodesFailed: 0 };
    }

    const rebuild = await this.nodes.rebuildAll();
    this.log.log(
      `истекло: ${expired.length}, сброшен трафик: ${reset} (вернулось в active: ${restored}), ` +
        `приостановлено по лимиту: ${suspended.length}, пересобрано нод: ${rebuild.changed.length}`,
    );

    return {
      expired: expired.length,
      subscriptionIds: expired.map((s) => s.id),
      trafficReset: reset,
      trafficRestored: restored,
      trafficSuspended: suspended.length,
      suspendedIds: suspended.map((s) => s.id),
      nodesTotal: rebuild.total,
      nodesChanged: rebuild.changed.length,
      nodesFailed: rebuild.failed.length,
    };
  }

  /**
   * Наступил новый период. Идемпотентность даёт сравнение с date_trunc: после сброса
   * last_traffic_reset_at попадает в текущий период и второй прогон подписку не видит.
   * Якорь для новых подписок — created_at, иначе первый же прогон обнулил бы реально
   * израсходованный трафик.
   */
  private periodDue(strategy: ResetStrategy) {
    return and(
      eq(schema.subscription.orgId, this.cfg.defaultOrgId),
      eq(schema.subscription.trafficLimitStrategy, strategy),
      sql`coalesce(${schema.subscription.lastTrafficResetAt}, ${schema.subscription.createdAt}) < date_trunc(${strategy}, now())`,
    );
  }

  /**
   * Возврат доступа перед сбросом счётчика. Условие «упёрся в лимит» проверяется здесь,
   * пока счётчик ещё не обнулён — так из suspended выходят только те, кого приостановил
   * лимит трафика, а приостановку за abuse по-прежнему снимают вручную из админки.
   */
  private async restoreAfterPeriod(strategy: ResetStrategy, now: Date) {
    return this.db
      .update(schema.subscription)
      .set({ status: "active", updatedAt: now })
      .where(
        and(
          this.periodDue(strategy),
          eq(schema.subscription.status, "suspended"),
          isNotNull(schema.subscription.trafficLimitBytes),
          sql`${schema.subscription.usedTrafficBytes} >= ${schema.subscription.trafficLimitBytes}`,
          sql`(${schema.subscription.expireAt} is null or ${schema.subscription.expireAt} > now())`,
        ),
      )
      .returning({ id: schema.subscription.id });
  }

  private async resetPeriod(strategy: ResetStrategy, now: Date) {
    return this.db
      .update(schema.subscription)
      .set({ usedTrafficBytes: 0, lastTrafficResetAt: now, updatedAt: now })
      .where(this.periodDue(strategy))
      .returning({ id: schema.subscription.id });
  }

  /**
   * Выборка лимита: suspended снимает юзера с нод при ближайшей пересборке desired-state.
   * Без этого traffic_limit_bytes был чисто декоративным — качать можно было бесконечно.
   */
  private async suspendOverLimit(now: Date) {
    return this.db
      .update(schema.subscription)
      .set({ status: "suspended", updatedAt: now })
      .where(
        and(
          eq(schema.subscription.orgId, this.cfg.defaultOrgId),
          inArray(schema.subscription.status, ["active", "trial"]),
          isNotNull(schema.subscription.trafficLimitBytes),
          sql`${schema.subscription.trafficLimitBytes} > 0`,
          sql`${schema.subscription.usedTrafficBytes} >= ${schema.subscription.trafficLimitBytes}`,
        ),
      )
      .returning({ id: schema.subscription.id });
  }
}

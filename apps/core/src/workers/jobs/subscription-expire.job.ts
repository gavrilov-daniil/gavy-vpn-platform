import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { DB } from "../../db/db.module.js";
import { loadConfig } from "../../config.js";
import { NodeStateService } from "../../nodes/node-state.service.js";
import type { JobRunner } from "../job.types.js";

/**
 * Истечение подписок. Идемпотентность — в самом условии: второй прогон уже никого не находит
 * (статус active|trial + expire_at в прошлом).
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

    if (expired.length === 0) return { expired: 0, nodesTotal: 0, nodesChanged: 0, nodesFailed: 0 };

    const rebuild = await this.nodes.rebuildAll();
    this.log.log(`истекло подписок: ${expired.length}, пересобрано нод: ${rebuild.changed.length}`);

    return {
      expired: expired.length,
      subscriptionIds: expired.map((s) => s.id),
      nodesTotal: rebuild.total,
      nodesChanged: rebuild.changed.length,
      nodesFailed: rebuild.failed.length,
    };
  }
}

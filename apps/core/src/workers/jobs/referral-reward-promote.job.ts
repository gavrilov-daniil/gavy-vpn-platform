import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../../db/db.module.js";
import { loadConfig } from "../../config.js";
import { LedgerService } from "../../payments/ledger.service.js";
import type { JobRunner } from "../job.types.js";

/**
 * Продвижение реф-наград по антифрод-выдержке:
 *   pending_refund_window (истекло окно возврата) → pending_hold
 *   pending_hold (наступил available_at)         → available + запись в ledger
 *
 * Начисление и смена статуса — в одной транзакции, статус берётся compare-and-swap'ом:
 * два воркера на одной награде дадут одну ledger-запись (плюс unique на idempotency_key
 * как последний рубеж).
 */
@Injectable()
export class ReferralRewardPromoteJob implements JobRunner {
  readonly jobName = "referral-reward-promote" as const;
  private readonly log = new Logger(ReferralRewardPromoteJob.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly ledger: LedgerService,
  ) {}

  async run() {
    const now = new Date();

    const toHold = await this.db
      .update(schema.referralReward)
      .set({ status: "pending_hold" })
      .where(
        and(
          eq(schema.referralReward.orgId, this.cfg.defaultOrgId),
          eq(schema.referralReward.status, "pending_refund_window"),
          isNotNull(schema.referralReward.refundWindowUntil),
          lt(schema.referralReward.refundWindowUntil, now),
        ),
      )
      .returning({ id: schema.referralReward.id });

    const candidates = await this.db
      .select()
      .from(schema.referralReward)
      .where(
        and(
          eq(schema.referralReward.orgId, this.cfg.defaultOrgId),
          eq(schema.referralReward.status, "pending_hold"),
          isNotNull(schema.referralReward.availableAt),
          lt(schema.referralReward.availableAt, now),
        ),
      );

    let credited = 0;
    let creditedKopeks = 0;
    for (const reward of candidates) {
      const applied = await this.db.transaction(async (tx) => {
        const claimed = await tx
          .update(schema.referralReward)
          .set({ status: "available", creditedAt: now })
          .where(
            and(
              eq(schema.referralReward.id, reward.id),
              eq(schema.referralReward.status, "pending_hold"),
            ),
          )
          .returning({ id: schema.referralReward.id });

        if (claimed.length === 0) return false;

        await this.ledger.creditReferral(tx, {
          subscriberId: reward.referrerSubscriberId,
          amountKopeks: reward.amountKopeks,
          rewardId: reward.id,
        });
        return true;
      });

      if (applied) {
        credited++;
        creditedKopeks += reward.amountKopeks;
      }
    }

    if (toHold.length > 0 || credited > 0) {
      this.log.log(`реф-награды: в hold ${toHold.length}, начислено ${credited} на ${creditedKopeks} коп.`);
    }
    return { movedToHold: toHold.length, credited, creditedKopeks };
  }
}

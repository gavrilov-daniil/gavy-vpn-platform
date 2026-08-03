import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { DB } from "../../db/db.module.js";
import { loadConfig } from "../../config.js";
import { AlertService, dayBucket } from "../alert.service.js";
import type { JobRunner } from "../job.types.js";

/** Платёж старше этого возраста в незавершённом статусе — повод разобраться. */
const STUCK_AFTER_MS = 30 * 60_000;
/** Дальше этого возраста ждать смысла нет: счёт у провайдера давно истёк. */
const GIVE_UP_AFTER_MS = 7 * 24 * 3600_000;

/**
 * Досбор платежей — страховка от тихой потери оплаты.
 *
 * Вебхук отвечает 200 даже на внутренней ошибке (иначе провайдер завалит ретраями),
 * а значит любой сбой обработки означает: деньги у мерчанта, услуги нет, и никто
 * об этом не узнает. Эта джоба ищет такие платежи и поднимает их операторам.
 *
 * Автоматически ничего не зачисляет: подтверждение оплаты должно приходить от
 * провайдера, а не выдумываться нами. Задача джобы — сделать проблему видимой.
 */
@Injectable()
export class PaymentReconcileJob implements JobRunner {
  readonly jobName = "payment-reconcile" as const;
  private readonly log = new Logger(PaymentReconcileJob.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly alerts: AlertService,
  ) {}

  async run() {
    const now = Date.now();
    const stuckBefore = new Date(now - STUCK_AFTER_MS);
    const giveUpBefore = new Date(now - GIVE_UP_AFTER_MS);

    const stuck = await this.db
      .select({ p: schema.payment, s: schema.subscriber })
      .from(schema.payment)
      .leftJoin(schema.subscriber, eq(schema.payment.subscriberId, schema.subscriber.id))
      .where(
        and(
          eq(schema.payment.orgId, this.cfg.defaultOrgId),
          inArray(schema.payment.status, ["pending", "processing"]),
          lt(schema.payment.createdAt, stuckBefore),
          gt(schema.payment.createdAt, giveUpBefore),
        ),
      )
      .orderBy(schema.payment.createdAt);

    // processing — это либо недоплата, либо несовпадение суммы: всегда ручной разбор
    const needsReview = stuck.filter((r) => r.p.status === "processing");

    for (const row of needsReview) {
      await this.alerts.alertOnce(
        `payment_review:${row.p.id}:${dayBucket()}`,
        [
          `💸 Платёж требует разбора`,
          `провайдер: ${row.p.provider}, счёт: ${row.p.providerPaymentId}`,
          `сумма: ${(Number(row.p.amountKopeks) / 100).toFixed(2)} ₽`,
          `клиент: ${row.s?.username ?? row.s?.telegramId ?? "—"}`,
          `статус: ${row.p.status} с ${row.p.createdAt.toISOString()}`,
        ].join("\n"),
      );
    }

    // Платежи, по которым оплата так и не пришла, закрываем — они засоряют выборку
    // и мешают увидеть настоящие проблемы. Деньги тут не терялись: счёт не оплачен.
    const expired = await this.db
      .update(schema.payment)
      .set({ status: "expired" })
      .where(
        and(
          eq(schema.payment.orgId, this.cfg.defaultOrgId),
          eq(schema.payment.status, "pending"),
          lt(schema.payment.createdAt, giveUpBefore),
        ),
      )
      .returning({ id: schema.payment.id });

    if (needsReview.length > 0 || expired.length > 0) {
      this.log.warn(`платежи: ${needsReview.length} на разбор, ${expired.length} просрочено`);
    }

    return {
      stuck: stuck.length,
      needsReview: needsReview.length,
      expired: expired.length,
    };
  }
}

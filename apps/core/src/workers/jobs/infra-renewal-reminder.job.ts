import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, isNotNull, lt } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { DB } from "../../db/db.module.js";
import { loadConfig } from "../../config.js";
import { AlertService, dayBucket } from "../alert.service.js";
import type { JobRunner } from "../job.types.js";

const THRESHOLDS_DAYS = [14, 7, 1] as const;
const DAY_MS = 86_400_000;

/**
 * Напоминание операторам о продлении инфраструктуры (VPS, домены, лицензии).
 * Окно — сутки от порога, так что за жизнь ресурса каждый порог срабатывает один раз.
 * Дедуп ключа `infra_renewal:<resourceId>:<threshold>:<date>` — в AlertService.
 */
@Injectable()
export class InfraRenewalReminderJob implements JobRunner {
  readonly jobName = "infra-renewal-reminder" as const;
  private readonly log = new Logger(InfraRenewalReminderJob.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly alerts: AlertService,
  ) {}

  async run() {
    const now = Date.now();
    const bucket = dayBucket();
    const counts = { targets: 0, sent: 0, duplicate: 0, failed: 0 };

    for (const days of THRESHOLDS_DAYS) {
      const from = new Date(now + days * DAY_MS);
      const to = new Date(now + (days + 1) * DAY_MS);

      const rows = await this.db
        .select({ resource: schema.infraResource, provider: schema.infraProvider })
        .from(schema.infraResource)
        .leftJoin(schema.infraProvider, eq(schema.infraResource.providerId, schema.infraProvider.id))
        .where(
          and(
            eq(schema.infraResource.orgId, this.cfg.defaultOrgId),
            eq(schema.infraResource.isActive, true),
            isNotNull(schema.infraResource.nextRenewalAt),
            gte(schema.infraResource.nextRenewalAt, from),
            lt(schema.infraResource.nextRenewalAt, to),
          ),
        );

      counts.targets += rows.length;

      for (const { resource, provider } of rows) {
        const outcome = await this.alerts.alertOnce(
          `infra_renewal:${resource.id}:${days}:${bucket}`,
          alertText(resource, provider?.name ?? null, days),
        );
        if (outcome === "sent") counts.sent++;
        else if (outcome === "duplicate") counts.duplicate++;
        else counts.failed++;
      }
    }

    this.log.log(`напоминания о продлении инфраструктуры: ${JSON.stringify(counts)}`);
    return counts;
  }
}

function alertText(
  resource: typeof schema.infraResource.$inferSelect,
  providerName: string | null,
  days: number,
): string {
  const lines = [
    `🧾 Продление через ${days} дн.: <b>${resource.label}</b> (${resource.kind})`,
    providerName ? `Провайдер: ${providerName}` : null,
    resource.monthlyCostKopeks
      ? `Стоимость: ${(resource.monthlyCostKopeks / 100).toFixed(2)} ${resource.currency} / ${resource.billingPeriod}`
      : null,
    resource.autoRenew ? "Автопродление: включено" : "Автопродление: <b>выключено</b>",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

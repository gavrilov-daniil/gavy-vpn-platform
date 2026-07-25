import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { DB } from "../../db/db.module.js";
import { loadConfig } from "../../config.js";
import { BroadcastService } from "../../broadcast/broadcast.service.js";
import type { JobRunner } from "../job.types.js";

/**
 * Добор упавших рассылок: воркер умер посреди прогона, статус остался running,
 * часть получателей — в pending. BroadcastService.run добирает именно pending.
 *
 * Аренду берёт сам run() (broadcast.started_at, см. BroadcastService.claim), и она общая
 * с ручным прогоном из админки. Держи джоба собственный claim, живая рассылка, запущенная
 * кнопкой, была бы для неё просто «running» и погналась бы вторым потоком: дубли сообщений
 * гасит dedup_key в message_log, но фактический темп вышел бы вдвое выше throttle_per_sec.
 */
@Injectable()
export class BroadcastResumeJob implements JobRunner {
  readonly jobName = "broadcast-resume" as const;
  private readonly log = new Logger(BroadcastResumeJob.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly broadcasts: BroadcastService,
  ) {}

  async run() {
    const running = await this.db
      .select({ id: schema.broadcast.id, title: schema.broadcast.title })
      .from(schema.broadcast)
      .where(and(eq(schema.broadcast.orgId, this.cfg.defaultOrgId), eq(schema.broadcast.status, "running")));

    const resumed: string[] = [];
    const skipped: string[] = [];

    for (const b of running) {
      try {
        const result = await this.broadcasts.run(b.id);
        if (!result.ok) {
          skipped.push(b.id);
          continue;
        }
        this.log.log(`возобновлена рассылка ${b.title} (${b.id})`);
        resumed.push(b.id);
      } catch (err) {
        this.log.error(`рассылка ${b.id} упала: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { running: running.length, resumed, skipped };
  }
}

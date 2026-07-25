import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { DB } from "../../db/db.module.js";
import { loadConfig } from "../../config.js";
import { BroadcastService } from "../../broadcast/broadcast.service.js";
import type { JobRunner } from "../job.types.js";

/** Аренда рассылки. Переживший процесс не должен держать её вечно, поэтому с истечением. */
const LEASE_MINUTES = 5;
/** Продление аренды на ходу: прогон длиннее аренды, иначе её перехватит следующий тик джобы. */
const LEASE_RENEW_MS = 60_000;

/**
 * Добор упавших рассылок: воркер умер посреди прогона, статус остался running,
 * часть получателей — в pending. BroadcastService.run добирает именно pending.
 *
 * Claim делается в БД (broadcast.started_at как отметка аренды), а не Set'ом в памяти:
 * Set не видит fire-and-forget прогон из админки и второй процесс, из-за чего рассылка
 * гналась в два потока и фактический темп выходил вдвое выше throttle_per_sec — Telegram
 * отвечает на это 429. Дубли сообщений и без того гасит dedup_key в message_log,
 * но темп он не удерживает.
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
      if (!(await this.claim(b.id))) {
        skipped.push(b.id);
        continue;
      }

      const renew = setInterval(() => {
        void this.renewLease(b.id);
      }, LEASE_RENEW_MS);
      renew.unref();

      try {
        this.log.log(`возобновляю рассылку ${b.title} (${b.id})`);
        await this.broadcasts.run(b.id);
        resumed.push(b.id);
      } catch (err) {
        this.log.error(`рассылка ${b.id} упала: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearInterval(renew);
      }
    }

    return { running: running.length, resumed, skipped };
  }

  /** Взять аренду: получится только если её никто не держит или прошлый держатель отвалился. */
  private async claim(broadcastId: string): Promise<boolean> {
    const claimed = await this.db
      .update(schema.broadcast)
      .set({ startedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.broadcast.orgId, this.cfg.defaultOrgId),
          eq(schema.broadcast.id, broadcastId),
          eq(schema.broadcast.status, "running"),
          or(
            isNull(schema.broadcast.startedAt),
            sql`${schema.broadcast.startedAt} < now() - ${`${LEASE_MINUTES} minutes`}::interval`,
          ),
        ),
      )
      .returning({ id: schema.broadcast.id });
    return claimed.length > 0;
  }

  private async renewLease(broadcastId: string): Promise<void> {
    try {
      await this.db
        .update(schema.broadcast)
        .set({ startedAt: new Date() })
        .where(
          and(
            eq(schema.broadcast.orgId, this.cfg.defaultOrgId),
            eq(schema.broadcast.id, broadcastId),
            eq(schema.broadcast.status, "running"),
          ),
        );
    } catch (err) {
      this.log.warn(`не удалось продлить аренду рассылки ${broadcastId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

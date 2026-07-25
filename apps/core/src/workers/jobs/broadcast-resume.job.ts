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
 * inFlight держит id рассылок, которые этот процесс уже гоняет: прогон длинный (троттлинг),
 * а джоба прилетает каждые 5 минут. Между процессами дублей не боимся — там барьером
 * стоит dedup_key в message_log, но лишнюю работу внутри процесса делать незачем.
 */
@Injectable()
export class BroadcastResumeJob implements JobRunner {
  readonly jobName = "broadcast-resume" as const;
  private readonly log = new Logger(BroadcastResumeJob.name);
  private readonly cfg = loadConfig();
  private readonly inFlight = new Set<string>();

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
      if (this.inFlight.has(b.id)) {
        skipped.push(b.id);
        continue;
      }
      this.inFlight.add(b.id);
      try {
        this.log.log(`возобновляю рассылку ${b.title} (${b.id})`);
        await this.broadcasts.run(b.id);
        resumed.push(b.id);
      } catch (err) {
        this.log.error(`рассылка ${b.id} упала: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.inFlight.delete(b.id);
      }
    }

    return { running: running.length, resumed, skipped };
  }
}

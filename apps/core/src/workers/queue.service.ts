import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "../config.js";
import type { JobName } from "./job.types.js";

export const JOBS_QUEUE = "core-jobs";

export type JobHandler = (name: JobName) => Promise<Record<string, unknown>>;

/**
 * BullMQ поверх Redis. Если REDIS_URL не задан — сервис не падает, а работает в degraded-режиме:
 * очереди нет, расписание не регистрируется, джобы гоняются только руками через
 * POST /api/admin/jobs/:name/run. Это нужно, чтобы core поднимался локально без Redis.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(QueueService.name);
  private readonly cfg = loadConfig();

  private connection: Redis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private connectionErrorLogged = false;

  get degraded(): boolean {
    return this.queue === null;
  }

  onModuleInit(): void {
    if (!this.cfg.redisUrl) {
      this.log.warn("REDIS_URL не задан: очередей нет, джобы доступны только вручную (degraded)");
      return;
    }

    // maxRetriesPerRequest: null — требование BullMQ: блокирующие команды воркера не должны отваливаться по лимиту.
    this.connection = new Redis(this.cfg.redisUrl, { maxRetriesPerRequest: null });
    this.connection.on("error", (err) => {
      if (this.connectionErrorLogged) return;
      this.connectionErrorLogged = true;
      this.log.error(`redis недоступен: ${err.message} (дальнейшие ошибки соединения не логируются)`);
    });
    this.connection.on("ready", () => {
      this.connectionErrorLogged = false;
    });

    this.queue = new Queue(JOBS_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    });
    this.log.log(`очередь ${JOBS_QUEUE} подключена`);
  }

  /** Консьюмер. Поднимается только в INSTANCE_TYPE=worker. */
  startWorker(handler: JobHandler): boolean {
    if (!this.connection) return false;
    if (this.worker) return true;

    this.worker = new Worker(
      JOBS_QUEUE,
      async (job: Job) => handler(job.name as JobName),
      { connection: this.connection, concurrency: 4 },
    );

    this.worker.on("failed", (job, err) => {
      this.log.error(`джоба ${job?.name ?? "?"} (${job?.id ?? "?"}) упала: ${err.message}`);
    });
    this.log.log(`воркер очереди ${JOBS_QUEUE} запущен`);
    return true;
  }

  /** Расписание регистрирует SchedulerService — доступ к Queue отдаём явно, без обёрток. */
  getQueue(): Queue | null {
    return this.queue;
  }

  /**
   * Барьер «сделать один раз в окне» для действий БЕЗ строки в БД (алерты операторам).
   * Без Redis барьера нет — возвращаем true и пишем предупреждение, чтобы это было видно.
   */
  async claimOnce(key: string, ttlSec: number): Promise<boolean> {
    if (!this.connection) {
      this.log.warn(`дедуп ${key} пропущен: нет Redis`);
      return true;
    }
    const claimed = await this.connection.set(`once:${key}`, String(Date.now()), "EX", ttlSec, "NX");
    return claimed !== null;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.connection?.disconnect();
  }
}

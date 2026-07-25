import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { JOB_NAMES } from "./job.types.js";
import { SCHEDULE, SCHEDULE_TZ, schedulerId } from "./schedule.js";
import { LeaderLockService } from "./leader-lock.service.js";
import { QueueService } from "./queue.service.js";

const LEADER_RETRY_MS = 60_000;

/**
 * Регистрация cron-расписания в BullMQ. Работает только на лидере (advisory-lock):
 * джобы кладёт один инстанс, разбирают все. Синглтон-планировщика нет — воркеры
 * масштабируются горизонтально.
 *
 * Если лидером стать не удалось, пробуем снова раз в минуту: лидер может умереть,
 * и тогда расписание должно подхватиться без ручного вмешательства.
 */
@Injectable()
export class SchedulerService implements OnModuleDestroy {
  private readonly log = new Logger(SchedulerService.name);
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly queue: QueueService,
    private readonly leader: LeaderLockService,
  ) {}

  async start(): Promise<boolean> {
    if (this.queue.degraded) {
      this.log.warn("расписание не зарегистрировано: нет Redis");
      return false;
    }

    const registered = await this.tryRegister();
    if (!registered && !this.retryTimer) {
      this.retryTimer = setInterval(() => {
        void this.tryRegister().then((ok) => {
          if (ok) this.stopRetry();
        });
      }, LEADER_RETRY_MS);
      this.retryTimer.unref();
    }
    return registered;
  }

  private async tryRegister(): Promise<boolean> {
    const queue = this.queue.getQueue();
    if (!queue) return false;

    if (!(await this.leader.tryAcquire())) {
      this.log.log("cron-эмиттер уже занят другим инстансом, работаем только консьюмером");
      return false;
    }

    for (const name of JOB_NAMES) {
      await queue.upsertJobScheduler(
        schedulerId(name),
        { pattern: SCHEDULE[name], tz: SCHEDULE_TZ },
        { name },
      );
    }
    this.log.log(`расписание зарегистрировано (${JOB_NAMES.length} джоб, tz=${SCHEDULE_TZ})`);
    return true;
  }

  private stopRetry(): void {
    if (!this.retryTimer) return;
    clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  onModuleDestroy(): void {
    this.stopRetry();
  }
}

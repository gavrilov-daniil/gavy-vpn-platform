import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { Database } from "@corelink/db";
import { DB } from "../db/db.module.js";

/** Произвольная константа, общая на весь кластер. Одна на роль cron-эмиттера. */
const CRON_LEADER_LOCK_KEY = 872_014_651;

type ReservedConnection = Awaited<ReturnType<Database["$client"]["reserve"]>>;

/**
 * Leader-lock через `pg_try_advisory_lock` вместо синглтон-планировщика (боль Remnawave:
 * их scheduler нельзя размножить). Cron-эмиттер работает на одном инстансе; сами джобы
 * разбирает любой воркер.
 *
 * Лок сессионный, поэтому берётся на ЗАРЕЗЕРВИРОВАННОМ соединении: в пуле postgres-js
 * следующий запрос ушёл бы в другую сессию, и лок «уплыл» бы вместе с ней.
 */
@Injectable()
export class LeaderLockService implements OnModuleDestroy {
  private readonly log = new Logger(LeaderLockService.name);
  private reserved: ReservedConnection | null = null;

  constructor(@Inject(DB) private readonly db: Database) {}

  async tryAcquire(): Promise<boolean> {
    if (this.reserved) return true;

    const reserved = await this.db.$client.reserve();
    try {
      const rows = await reserved<Array<{ locked: boolean }>>`
        select pg_try_advisory_lock(${CRON_LEADER_LOCK_KEY}) as locked
      `;
      if (!rows[0]?.locked) {
        reserved.release();
        return false;
      }
      this.reserved = reserved;
      this.log.log("cron-лидер: лок взят");
      return true;
    } catch (err) {
      reserved.release();
      throw err;
    }
  }

  async release(): Promise<void> {
    if (!this.reserved) return;
    const reserved = this.reserved;
    this.reserved = null;
    try {
      await reserved`select pg_advisory_unlock(${CRON_LEADER_LOCK_KEY})`;
    } finally {
      reserved.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.release();
  }
}

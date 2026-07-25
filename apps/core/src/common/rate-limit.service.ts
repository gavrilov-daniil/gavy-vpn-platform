import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { loadConfig } from "../config.js";

export interface RateLimitRule {
  /** 0 и меньше — правило выключено (ops-рубильник без выкатки кода). */
  limit: number;
  windowSec: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Секунды до момента, когда самая старая отметка выйдет из окна. 0 — запрос разрешён. */
  retryAfterSec: number;
}

const ALLOWED: RateLimitDecision = { allowed: true, retryAfterSec: 0 };

/** Потолок ключей в памяти одного процесса — защита от роста Map при переборе с разных IP. */
const MEMORY_KEY_CAP = 50_000;

interface MemoryEntry {
  hits: number[];
  expiresAt: number;
}

/**
 * Скользящее окно (лог отметок) для публичных эндпоинтов.
 *
 * Хранилище: Redis при заданном REDIS_URL, иначе память процесса — core обязан
 * подниматься без Redis (degraded, docs/workers.md). В памяти барьер размывается
 * на втором инстансе api, это осознанная цена.
 *
 * Любая ошибка лимитера = запрос ПРОПУСКАЕМ. Доступность подписки важнее лимита:
 * лежащий Redis не должен отнимать конфиг у всей базы клиентов.
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly log = new Logger(RateLimitService.name);
  private readonly redis: Redis | null;
  private readonly memory = new Map<string, MemoryEntry>();
  private redisErrorLogged = false;

  constructor() {
    const { redisUrl } = loadConfig();
    this.redis = redisUrl ? this.connect(redisUrl) : null;
    if (!this.redis) {
      this.log.warn("REDIS_URL не задан: лимиты считаются в памяти процесса, общего барьера между инстансами нет");
    }
  }

  async check(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    if (rule.limit <= 0 || rule.windowSec <= 0) return ALLOWED;
    try {
      return this.redis ? await this.checkRedis(key, rule) : this.checkMemory(key, rule);
    } catch (err) {
      this.log.warn(`лимитер пропустил запрос ${key}: ${err instanceof Error ? err.message : String(err)}`);
      return ALLOWED;
    }
  }

  private connect(url: string): Redis {
    // enableOfflineQueue:false + commandTimeout: команда к лежащему Redis отваливается сразу,
    // а не держит выдачу подписки; отказ уходит в fail-open внутри check().
    const redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 500,
    });
    redis.on("error", (err) => {
      if (this.redisErrorLogged) return;
      this.redisErrorLogged = true;
      this.log.warn(`redis недоступен, лимиты пропускаются: ${err.message} (повторы не логируются)`);
    });
    redis.on("ready", () => {
      this.redisErrorLogged = false;
    });
    return redis;
  }

  private async checkRedis(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    const redis = this.redis!;
    const now = Date.now();
    const windowMs = rule.windowSec * 1000;
    const k = `rl:${key}`;

    const read = await redis
      .multi()
      .zremrangebyscore(k, 0, now - windowMs)
      .zcard(k)
      .zrange(k, 0, 0, "WITHSCORES")
      .exec();
    if (!read) throw new Error("redis multi вернул null");
    for (const [err] of read) if (err) throw err;

    const count = Number(read[1]?.[1] ?? 0);
    if (count >= rule.limit) {
      const oldest = Number((read[2]?.[1] as string[] | undefined)?.[1] ?? now);
      return { allowed: false, retryAfterSec: secondsUntil(oldest + windowMs - now) };
    }

    // Отметку ставим ТОЛЬКО за разрешённый запрос. Иначе клиент, долбящийся в 429,
    // продлевает себе блокировку и не выбирается из неё, пока не замолчит целиком.
    const write = await redis
      .multi()
      .zadd(k, now, `${now}-${randomBytes(4).toString("hex")}`)
      .pexpire(k, windowMs)
      .exec();
    if (write) for (const [err] of write) if (err) throw err;
    return ALLOWED;
  }

  private checkMemory(key: string, rule: RateLimitRule): RateLimitDecision {
    const now = Date.now();
    const windowMs = rule.windowSec * 1000;
    this.capMemory(now);

    const hits = (this.memory.get(key)?.hits ?? []).filter((ts) => ts > now - windowMs);
    if (hits.length >= rule.limit) {
      this.memory.set(key, { hits, expiresAt: now + windowMs });
      return { allowed: false, retryAfterSec: secondsUntil(hits[0]! + windowMs - now) };
    }
    hits.push(now);
    this.memory.set(key, { hits, expiresAt: now + windowMs });
    return ALLOWED;
  }

  private capMemory(now: number): void {
    if (this.memory.size < MEMORY_KEY_CAP) return;
    for (const [key, entry] of this.memory) {
      if (entry.expiresAt <= now) this.memory.delete(key);
    }
    if (this.memory.size < MEMORY_KEY_CAP) return;
    // Живых ключей больше потолка — сбрасываем окно целиком: память процесса дороже
    // точности лимита, который без Redis и так приблизительный.
    this.memory.clear();
    this.log.warn(`лимитер в памяти: больше ${MEMORY_KEY_CAP} живых ключей, окно сброшено`);
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }
}

function secondsUntil(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

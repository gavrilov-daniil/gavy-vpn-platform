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
 * Проверка и отметка одним шагом на стороне Redis.
 *
 * Раздельные multi() на чтение и на запись давали окно, в котором N параллельных
 * запросов читали count=0 до первого zadd и проходили ВСЕ. На логине окно ещё и
 * растянуто scrypt'ом (~50–100 мс), так что «5 попыток за 900 с» превращалось в
 * «сколько влезет в конкурентность». Скрипт исполняется атомарно, промежуточного
 * состояния между zcard и zadd не существует.
 *
 * Отметка ставится ТОЛЬКО за разрешённый запрос: иначе клиент, долбящийся в 429,
 * продлевает себе блокировку и не выбирается из неё, пока не замолчит целиком.
 */
const SLIDING_WINDOW_LUA = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local resetIn = window
  if oldest[2] then resetIn = tonumber(oldest[2]) + window - now end
  return {0, resetIn}
end

redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return {1, 0}
`;

/** ioredis-клиент с зарегистрированным скриптом окна (defineCommand типов не добавляет). */
type LimiterRedis = Redis & {
  slidingWindow(key: string, now: number, windowMs: number, limit: number, member: string): Promise<[number, number]>;
};

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
  private readonly redis: LimiterRedis | null;
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

  private connect(url: string): LimiterRedis {
    // enableOfflineQueue:false + commandTimeout: команда к лежащему Redis отваливается сразу,
    // а не держит выдачу подписки; отказ уходит в fail-open внутри check().
    const redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 500,
    }) as LimiterRedis;
    // defineCommand шлёт EVALSHA и сам подгружает скрипт на NOSCRIPT — тело не летит на каждый запрос
    redis.defineCommand("slidingWindow", { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
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
    const now = Date.now();
    const windowMs = rule.windowSec * 1000;
    const member = `${now}-${randomBytes(4).toString("hex")}`;

    const [allowed, resetInMs] = await this.redis!.slidingWindow(`rl:${key}`, now, windowMs, rule.limit, member);
    if (allowed === 1) return ALLOWED;
    return { allowed: false, retryAfterSec: secondsUntil(resetInMs) };
  }

  /**
   * Память процесса: чтение и запись лежат в одном синхронном участке, между ними
   * нет ни одного await — на однопоточном рантайме этого достаточно, параллельный
   * запрос не может вклиниться. Убирать синхронность нельзя, это и есть атомарность.
   */
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

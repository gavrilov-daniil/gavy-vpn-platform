import { ConflictException, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { loadConfig } from "../config.js";

interface Entry {
  status: "pending" | "done";
  result?: unknown;
  expiresAt: number;
}

const TTL_MS = 24 * 3600_000;

/** Потолок ключей в памяти одного процесса — чтобы перебор заголовка не растил Map бесконечно. */
const MEMORY_KEY_CAP = 50_000;

/**
 * Идемпотентность операций записи по клиентскому ключу (`x-client-request-id`).
 *
 * Зачем: бот шлёт ключ, чтобы дабл-тап по кнопке оплаты не создал два счёта у провайдера.
 * Барьер в памяти бота не переживает рестарт и не работает на втором инстансе, поэтому
 * решение живёт на сервере.
 *
 * Хранилище — Redis при заданном REDIS_URL, иначе память процесса: core обязан подниматься
 * без Redis (degraded, docs/workers.md). В памяти барьер размывается на втором инстансе api.
 *
 * Отличие от лимитера: здесь ошибка Redis НЕ пропускает запрос мимо барьера, а роняет
 * его в память процесса. Пропустить — значит выставить клиенту второй счёт у провайдера,
 * и unique-индексы БД от этого не спасают: они ловят двойное зачисление, а не двойной счёт.
 */
@Injectable()
export class IdempotencyService implements OnModuleDestroy {
  private readonly log = new Logger(IdempotencyService.name);
  private readonly redis: Redis | null;
  private readonly store = new Map<string, Entry>();
  private redisErrorLogged = false;

  constructor() {
    const { redisUrl } = loadConfig();
    this.redis = redisUrl ? this.connect(redisUrl) : null;
    if (!this.redis) {
      this.log.warn("REDIS_URL не задан: идемпотентность держится в памяти процесса, общего барьера между инстансами нет");
    }
  }

  async run<T>(scope: string, clientRequestId: string | undefined, factory: () => Promise<T>): Promise<T> {
    if (!clientRequestId) return factory();

    const key = this.buildKey(scope, clientRequestId);

    if (this.redis) {
      try {
        return await this.runRedis(key, scope, clientRequestId, factory);
      } catch (err) {
        if (err instanceof ConflictException) throw err;
        // Своя ошибка фабрики уже обработана внутри runRedis — сюда долетает только сбой Redis
        this.log.warn(`redis недоступен, идемпотентность падает в память: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return this.runMemory(key, scope, clientRequestId, factory);
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }

  private connect(url: string): Redis {
    // enableOfflineQueue:true — осознанное отличие от RateLimitService, где стоит false.
    // Там команда к неготовому Redis обязана отвалиться мгновенно: выдача подписки дёргается
    // каждым клиентом и ждать её нельзя, а пропущенный лимит — терпимо. Здесь наоборот:
    // соединение поднимается асинхронно, и с false первые запросы после старта процесса
    // уходили бы мимо общего барьера в память инстанса — дабл-тап сразу после деплоя
    // создавал бы два счёта у провайдера. Создание счёта — это нажатие кнопки, а не поллинг,
    // поэтому ожидание до commandTimeout здесь дешевле неверного результата.
    const redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
      commandTimeout: 1000,
    });
    redis.on("error", (err) => {
      if (this.redisErrorLogged) return;
      this.redisErrorLogged = true;
      this.log.warn(`redis недоступен: ${err.message} (повторы не логируются)`);
    });
    redis.on("ready", () => {
      this.redisErrorLogged = false;
    });
    return redis;
  }

  private async runRedis<T>(key: string, scope: string, clientRequestId: string, factory: () => Promise<T>): Promise<T> {
    // SET NX — атомарный захват: между проверкой и записью нет промежуточного состояния,
    // поэтому два одновременных запроса с одним ключом не могут оба уйти в фабрику.
    const claimed = await this.redis!.set(key, JSON.stringify({ status: "pending" }), "PX", TTL_MS, "NX");

    if (claimed !== "OK") {
      const raw = await this.redis!.get(key);
      // null = конкурент успел удалить ключ после своей ошибки: повторять его работу штатно
      if (raw !== null) {
        const entry = JSON.parse(raw) as { status: "pending" | "done"; result?: unknown };
        if (entry.status === "pending") {
          throw new ConflictException({ errorCode: "idempotency_in_progress", message: "операция уже выполняется" });
        }
        this.log.warn(`повтор по ключу ${scope}:${clientRequestId} — отдаём сохранённый результат`);
        return entry.result as T;
      }
    }

    try {
      const result = await factory();
      await this.redis!.set(key, JSON.stringify({ status: "done", result }), "PX", TTL_MS);
      return result;
    } catch (err) {
      // не оставляем «pending» до конца TTL: иначе повтор после сбоя провайдера залипнет в конфликте
      await this.redis!.del(key).catch(() => undefined);
      throw err;
    }
  }

  private async runMemory<T>(key: string, scope: string, clientRequestId: string, factory: () => Promise<T>): Promise<T> {
    this.sweep();

    const existing = this.store.get(key);
    if (existing) {
      if (existing.status === "pending") {
        throw new ConflictException({ errorCode: "idempotency_in_progress", message: "операция уже выполняется" });
      }
      this.log.warn(`повтор по ключу ${scope}:${clientRequestId} — отдаём сохранённый результат`);
      return existing.result as T;
    }

    this.store.set(key, { status: "pending", expiresAt: Date.now() + TTL_MS });
    try {
      const result = await factory();
      this.store.set(key, { status: "done", result, expiresAt: Date.now() + TTL_MS });
      return result;
    } catch (err) {
      this.store.delete(key);
      throw err;
    }
  }

  private buildKey(scope: string, clientRequestId: string): string {
    return `idem:${scope}:${createHash("sha256").update(clientRequestId).digest("hex").slice(0, 32)}`;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt < now) this.store.delete(key);
    }
    if (this.store.size <= MEMORY_KEY_CAP) return;
    // Перебор ключей не должен съедать память: режем самые старые записи
    const excess = this.store.size - MEMORY_KEY_CAP;
    let dropped = 0;
    for (const key of this.store.keys()) {
      this.store.delete(key);
      if (++dropped >= excess) break;
    }
  }
}

import { createHash } from "node:crypto";

/**
 * Ключ идемпотентности для действий клиента (дабл-тап по кнопке в боте).
 * Окно (bucketMs) склеивает повторные тапы в один ключ.
 */
export function buildIdempotencyKey(input: {
  subjectId: string;
  action: string;
  params?: Record<string, unknown>;
  bucketMs?: number;
  now?: number;
}): string {
  const bucketMs = input.bucketMs ?? 5 * 60_000;
  const now = input.now ?? Date.now();
  const bucket = Math.floor(now / bucketMs);
  const payload = JSON.stringify({
    s: input.subjectId,
    a: input.action,
    p: sortedParams(input.params ?? {}),
    b: bucket,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function sortedParams(params: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
}

/** Минимальный контракт Redis, чтобы не тащить сюда клиент. */
export interface RedisLike {
  set(key: string, value: string, mode: "EX", ttl: number, nx: "NX"): Promise<string | null>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number): Promise<string | null>;
  del(key: string): Promise<number>;
}

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_in_progress";
  constructor(key: string) {
    super(`operation already in progress: ${key}`);
    this.name = "IdempotencyConflictError";
  }
}

const PENDING = "pending:";

/**
 * Захватывает ключ и выполняет операцию ровно один раз.
 * Повтор после успеха → сохранённый результат; повтор во время выполнения → конфликт.
 * Это ВТОРОЙ барьер; первый — unique-индекс в БД, он же последний рубеж при гонке.
 */
export async function tryClaim<T>(
  redis: RedisLike,
  params: { scope: string; subjectId: string; requestId: string; ttlSec?: number },
  factory: () => Promise<T>,
): Promise<T> {
  const key = `dedup:${params.scope}:${params.subjectId}:${params.requestId}`;
  const ttl = params.ttlSec ?? 24 * 3600;

  const claimed = await redis.set(key, `${PENDING}${Date.now()}`, "EX", ttl, "NX");
  if (claimed === null) {
    const existing = await redis.get(key);
    if (existing && existing.startsWith(PENDING)) throw new IdempotencyConflictError(key);
    if (existing) return JSON.parse(existing) as T;
    throw new IdempotencyConflictError(key);
  }

  try {
    const result = await factory();
    await redis.set(key, JSON.stringify(result ?? null), "EX", ttl);
    return result;
  } catch (err) {
    // не оставляем «pending» навсегда — иначе повтор после сбоя залипнет в конфликте
    await redis.del(key).catch(() => undefined);
    throw err;
  }
}

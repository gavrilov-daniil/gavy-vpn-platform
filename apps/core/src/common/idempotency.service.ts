import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";

interface Entry {
  status: "pending" | "done";
  result?: unknown;
  expiresAt: number;
}

/**
 * Идемпотентность операций записи по клиентскому ключу (`x-client-request-id`).
 *
 * Зачем: бот шлёт ключ, чтобы дабл-тап по кнопке оплаты не создал два счёта.
 * Барьер в памяти бота не переживает рестарт и не работает на втором инстансе,
 * поэтому решение должно жить на сервере.
 *
 * Сейчас хранилище — память процесса. Этого достаточно для одного инстанса core;
 * при горизонтальном масштабировании сюда подставляется Redis (тот же интерфейс,
 * `tryClaim` из @vpn/core-kit). Последний рубеж в любом случае — unique-индексы БД.
 */
@Injectable()
export class IdempotencyService {
  private readonly log = new Logger(IdempotencyService.name);
  private readonly store = new Map<string, Entry>();
  private readonly ttlMs = 24 * 3600_000;

  async run<T>(scope: string, clientRequestId: string | undefined, factory: () => Promise<T>): Promise<T> {
    if (!clientRequestId) return factory();

    const key = this.buildKey(scope, clientRequestId);
    this.sweep();

    const existing = this.store.get(key);
    if (existing) {
      if (existing.status === "pending") {
        throw new ConflictException({ errorCode: "idempotency_in_progress", message: "операция уже выполняется" });
      }
      this.log.warn(`повтор по ключу ${scope}:${clientRequestId} — отдаём сохранённый результат`);
      return existing.result as T;
    }

    this.store.set(key, { status: "pending", expiresAt: Date.now() + this.ttlMs });
    try {
      const result = await factory();
      this.store.set(key, { status: "done", result, expiresAt: Date.now() + this.ttlMs });
      return result;
    } catch (err) {
      // не оставляем «pending» навсегда: иначе повтор после сбоя провайдера залипнет в конфликте
      this.store.delete(key);
      throw err;
    }
  }

  private buildKey(scope: string, clientRequestId: string): string {
    return `${scope}:${createHash("sha256").update(clientRequestId).digest("hex").slice(0, 32)}`;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt < now) this.store.delete(key);
    }
  }
}

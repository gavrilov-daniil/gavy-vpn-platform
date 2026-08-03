import "reflect-metadata";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { RateLimitService } from "./rate-limit.service.js";

/**
 * Redis-режим проверяется отдельным блоком ниже, поэтому адрес забираем ДО создания
 * основного сервиса и убираем из env: иначе «память процесса» молча считалась бы в
 * Redis у разработчика с заданным REDIS_URL, и половина файла проверяла бы не тот код.
 */
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "";
delete process.env.REDIS_URL;

// Без REDIS_URL сервис считает окно в памяти — ровно тот режим, в котором core
// поднимается локально и в degraded-проде.
const limiter = new RateLimitService();
after(() => limiter.onModuleDestroy());

const rule = { limit: 3, windowSec: 60 };

describe("RateLimitService (память процесса)", () => {
  it("пропускает до лимита и отказывает после", async () => {
    const key = `k-${Math.random()}`;
    for (let i = 0; i < rule.limit; i += 1) {
      assert.equal((await limiter.check(key, rule)).allowed, true, `запрос ${i + 1} должен пройти`);
    }

    const denied = await limiter.check(key, rule);
    assert.equal(denied.allowed, false);
    assert.ok(denied.retryAfterSec > 0 && denied.retryAfterSec <= rule.windowSec);
  });

  it("отказ не продлевает блокировку: клиент, долбящийся в 429, не запирает себя навсегда", async () => {
    const key = `k-${Math.random()}`;
    for (let i = 0; i < rule.limit; i += 1) await limiter.check(key, rule);

    const first = await limiter.check(key, rule);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const later = await limiter.check(key, rule);

    assert.equal(later.allowed, false);
    assert.ok(later.retryAfterSec <= first.retryAfterSec, "retry-after обязан убывать со временем");
  });

  it("ключи независимы: сосед по NAT не тратит чужое окно", async () => {
    const mine = `k-${Math.random()}`;
    const other = `k-${Math.random()}`;
    for (let i = 0; i < rule.limit; i += 1) await limiter.check(mine, rule);

    assert.equal((await limiter.check(mine, rule)).allowed, false);
    assert.equal((await limiter.check(other, rule)).allowed, true);
  });

  it("окно истекает — клиент возвращается к нормальной выдаче", async () => {
    const key = `k-${Math.random()}`;
    const short = { limit: 1, windowSec: 0.2 };

    assert.equal((await limiter.check(key, short)).allowed, true);
    assert.equal((await limiter.check(key, short)).allowed, false);

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal((await limiter.check(key, short)).allowed, true);
  });

  it("нулевой лимит выключает правило (ops-рубильник)", async () => {
    const key = `k-${Math.random()}`;
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await limiter.check(key, { limit: 0, windowSec: 60 })).allowed, true);
    }
  });

  it("параллельные запросы не проходят сверх лимита", async () => {
    const key = `k-${Math.random()}`;
    const decisions = await Promise.all(Array.from({ length: 20 }, () => limiter.check(key, rule)));

    const allowed = decisions.filter((d) => d.allowed).length;
    assert.equal(allowed, rule.limit, "чтение и отметка обязаны быть одним шагом: иначе все 20 читают count=0");
  });
});

/**
 * Тот же барьер против гонки, но в Redis: там проверка и отметка исполняются одним
 * Lua-скриптом, а не двумя раундтрипами. Ровно этот случай и был сломан — на логине
 * окно между чтением и записью растянуто scrypt'ом (~50–100 мс), и «5 попыток за
 * 900 с» превращались в «сколько влезет в конкурентность».
 *
 * Гоняется только при заданном REDIS_URL: в CI Redis нет, и тест обязан скипаться,
 * а не падать.
 */
describe("RateLimitService (Redis)", { skip: redisUrl ? false : "REDIS_URL не задан" }, () => {
  /**
   * Соединение с Redis поднимается асинхронно, а `enableOfflineQueue: false` отбивает
   * команды до готовности — и лимитер осознанно пропускает их (fail-open). Ждём не
   * таймером, а первым реально сработавшим отказом: иначе тест мерил бы скорость
   * коннекта, а не атомарность.
   */
  async function redisLimiter(): Promise<RateLimitService> {
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = redisUrl;
    // конфиг читается в конструкторе, поэтому env восстанавливаем сразу после
    const service = new RateLimitService();
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;

    const probe = { limit: 1, windowSec: 60 };
    for (let i = 0; i < 100; i += 1) {
      const key = `warmup-${Math.random()}`;
      const first = await service.check(key, probe);
      const second = await service.check(key, probe);
      if (first.allowed && !second.allowed) return service;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    service.onModuleDestroy();
    throw new Error(`redis-лимитер не поднялся на ${redisUrl}`);
  }

  it("параллельные запросы не проходят сверх лимита", async () => {
    const service = await redisLimiter();
    try {
      const key = `k-${Math.random()}`;
      const decisions = await Promise.all(Array.from({ length: 20 }, () => service.check(key, rule)));

      const allowed = decisions.filter((d) => d.allowed).length;
      assert.equal(allowed, rule.limit, "EVAL атомарен: 20 параллельных запросов не могут пройти все");
      const denied = decisions.find((d) => !d.allowed)!;
      assert.ok(denied.retryAfterSec > 0 && denied.retryAfterSec <= rule.windowSec);
    } finally {
      service.onModuleDestroy();
    }
  });

  it("окно истекает — клиент возвращается к нормальной выдаче", async () => {
    const service = await redisLimiter();
    try {
      const key = `k-${Math.random()}`;
      const short = { limit: 1, windowSec: 0.3 };

      assert.equal((await service.check(key, short)).allowed, true);
      assert.equal((await service.check(key, short)).allowed, false);

      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal((await service.check(key, short)).allowed, true);
    } finally {
      service.onModuleDestroy();
    }
  });
});

import "reflect-metadata";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { RateLimitService } from "./rate-limit.service.js";

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
});

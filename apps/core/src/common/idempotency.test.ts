import "reflect-metadata";
import assert from "node:assert/strict";
import { ConflictException } from "@nestjs/common";
import { after, describe, it } from "node:test";
import { IdempotencyService } from "./idempotency.service.js";

/**
 * Тот же приём, что в rate-limit.test.ts: адрес Redis забираем ДО создания сервиса
 * и убираем из env, иначе блок «память процесса» у разработчика с заданным REDIS_URL
 * молча проверял бы не тот код.
 */
const redisUrl = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "";
delete process.env.REDIS_URL;

const memory = new IdempotencyService();
after(() => memory.onModuleDestroy());

function key(): string {
  return `req-${Math.random()}`;
}

describe("IdempotencyService (память процесса)", () => {
  it("повторный вызов с тем же ключом не выполняет фабрику дважды", async () => {
    const id = key();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return { paymentId: `p-${calls}` };
    };

    const first = await memory.run("payment-create", id, factory);
    const second = await memory.run("payment-create", id, factory);

    assert.equal(calls, 1, "фабрика обязана выполниться один раз");
    assert.deepEqual(second, first, "повтор отдаёт сохранённый результат, а не новый счёт");
  });

  it("без ключа барьера нет: каждый вызов создаёт свой счёт", async () => {
    let calls = 0;
    const factory = async () => ({ paymentId: `p-${(calls += 1)}` });

    await memory.run("payment-create", undefined, factory);
    await memory.run("payment-create", undefined, factory);

    assert.equal(calls, 2);
  });

  it("разные scope не смешиваются при одинаковом ключе клиента", async () => {
    const id = key();
    const a = await memory.run("scope-a", id, async () => "a");
    const b = await memory.run("scope-b", id, async () => "b");

    assert.equal(a, "a");
    assert.equal(b, "b");
  });

  it("упавшая фабрика не залипает в pending: повтор после сбоя провайдера проходит", async () => {
    const id = key();
    await assert.rejects(
      memory.run("payment-create", id, async () => {
        throw new Error("провайдер недоступен");
      }),
      /провайдер недоступен/,
    );

    const retry = await memory.run("payment-create", id, async () => ({ paymentId: "p-ok" }));
    assert.deepEqual(retry, { paymentId: "p-ok" });
  });

  it("параллельный вызов с тем же ключом отбивается конфликтом, а не вторым счётом", async () => {
    const id = key();
    let calls = 0;
    const slow = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { paymentId: "p-1" };
    };

    const [first, second] = await Promise.allSettled([
      memory.run("payment-create", id, slow),
      memory.run("payment-create", id, slow),
    ]);

    assert.equal(calls, 1, "второй параллельный запрос не должен доходить до провайдера");
    assert.equal(first.status, "fulfilled");
    assert.equal(second.status, "rejected");
    assert.ok(
      second.status === "rejected" && second.reason instanceof ConflictException,
      "второй запрос обязан получить 409, а не тихо создать второй счёт",
    );
  });
});

/**
 * Redis-режим — это и есть смысл правки: барьер обязан переживать второй инстанс api.
 * Гоняется только при заданном REDIS_URL, в CI Redis нет и тест скипается.
 */
describe("IdempotencyService (Redis)", { skip: redisUrl ? false : "REDIS_URL не задан" }, () => {
  function redisService(): IdempotencyService {
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = redisUrl;
    const service = new IdempotencyService(); // конфиг читается в конструкторе
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;
    return service;
  }

  it("барьер общий для двух инстансов: второй отдаёт результат первого", async () => {
    const a = redisService();
    const b = redisService();
    try {
      const id = key();
      let calls = 0;
      const factory = async () => ({ paymentId: `p-${(calls += 1)}` });

      const first = await a.run("payment-create", id, factory);
      const second = await b.run("payment-create", id, factory);

      assert.equal(calls, 1, "второй инстанс не должен создавать свой счёт");
      assert.deepEqual(second, first);
    } finally {
      await a.onModuleDestroy();
      await b.onModuleDestroy();
    }
  });

  it("захват атомарен: одновременные запросы на разных инстансах не дают два счёта", async () => {
    const a = redisService();
    const b = redisService();
    try {
      const id = key();
      let calls = 0;
      const slow = async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { paymentId: "p-1" };
      };

      const results = await Promise.allSettled([
        a.run("payment-create", id, slow),
        b.run("payment-create", id, slow),
      ]);

      assert.equal(calls, 1, "к провайдеру обязан уйти ровно один запрос");
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    } finally {
      await a.onModuleDestroy();
      await b.onModuleDestroy();
    }
  });

  it("упавшая фабрика снимает захват и на общем хранилище", async () => {
    const a = redisService();
    const b = redisService();
    try {
      const id = key();
      await assert.rejects(
        a.run("payment-create", id, async () => {
          throw new Error("провайдер недоступен");
        }),
      );

      const retry = await b.run("payment-create", id, async () => ({ paymentId: "p-ok" }));
      assert.deepEqual(retry, { paymentId: "p-ok" });
    } finally {
      await a.onModuleDestroy();
      await b.onModuleDestroy();
    }
  });
});

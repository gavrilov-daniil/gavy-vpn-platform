import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret, isEncrypted, encryptCredentials, decryptCredentials, safeCompare } from "./crypto.js";
import { buildIdempotencyKey, tryClaim, IdempotencyConflictError, type RedisLike } from "./idempotency.js";
import { maskBody, maskUrl, maskValue } from "./mask.js";

const KEY = "test-master-key-do-not-use-in-prod";

test("шифрование кредов: round-trip и нестабильный ciphertext (IV случайный)", () => {
  const plain = "pal24-secret-token-value";
  const enc1 = encryptSecret(plain, KEY);
  const enc2 = encryptSecret(plain, KEY);
  assert.notEqual(enc1, enc2, "два шифрования одного текста не должны совпадать");
  assert.ok(isEncrypted(enc1));
  assert.equal(decryptSecret(enc1, KEY), plain);
  assert.equal(decryptSecret(enc2, KEY), plain);
});

test("шифрование: чужой ключ не расшифровывает (GCM auth tag)", () => {
  const enc = encryptSecret("secret", KEY);
  assert.throws(() => decryptSecret(enc, "wrong-key"));
});

test("шифрование: подмена шифртекста ловится auth tag'ом", () => {
  const enc = encryptSecret("secret", KEY);
  const [v, iv, tag, data] = enc.split(".");
  const tampered = [v, iv, tag, Buffer.from("evil").toString("base64")].join(".");
  assert.throws(() => decryptSecret(tampered, KEY));
});

test("encryptCredentials идемпотентен: повторное шифрование не двойное", () => {
  const creds = { api_key: "abc123", shop_id: "42" };
  const once = encryptCredentials(creds, KEY);
  const twice = encryptCredentials(once, KEY);
  assert.deepEqual(decryptCredentials(twice, KEY), creds);
});

test("safeCompare: равные и разной длины", () => {
  assert.equal(safeCompare("abc", "abc"), true);
  assert.equal(safeCompare("abc", "abd"), false);
  assert.equal(safeCompare("abc", "abcd"), false, "разная длина не должна кидать");
});

test("buildIdempotencyKey: стабилен в окне, порядок params не влияет", () => {
  const now = 1_700_000_000_000;
  const a = buildIdempotencyKey({ subjectId: "u1", action: "pay", params: { plan: "p1", n: 2 }, now });
  const b = buildIdempotencyKey({ subjectId: "u1", action: "pay", params: { n: 2, plan: "p1" }, now: now + 1000 });
  assert.equal(a, b);
  assert.equal(a.length, 32);
});

test("buildIdempotencyKey: разные субъект/действие/окно дают разные ключи", () => {
  const now = 1_700_000_000_000;
  const base = buildIdempotencyKey({ subjectId: "u1", action: "pay", now });
  assert.notEqual(base, buildIdempotencyKey({ subjectId: "u2", action: "pay", now }));
  assert.notEqual(base, buildIdempotencyKey({ subjectId: "u1", action: "topup", now }));
  assert.notEqual(base, buildIdempotencyKey({ subjectId: "u1", action: "pay", now: now + 6 * 60_000 }));
});

function fakeRedis(): RedisLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, value: string, _m: "EX", _ttl: number, nx?: "NX") {
      if (nx === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
  } as RedisLike & { store: Map<string, string> };
}

test("tryClaim: операция выполняется один раз, повтор отдаёт кэш", async () => {
  const redis = fakeRedis();
  let calls = 0;
  const run = () =>
    tryClaim(redis, { scope: "pay", subjectId: "u1", requestId: "req1" }, async () => {
      calls++;
      return { paymentId: "p1" };
    });

  assert.deepEqual(await run(), { paymentId: "p1" });
  assert.deepEqual(await run(), { paymentId: "p1" });
  assert.equal(calls, 1, "factory должна вызваться ровно один раз");
});

test("tryClaim: после ошибки ключ освобождается (не залипает в pending)", async () => {
  const redis = fakeRedis();
  await assert.rejects(
    tryClaim(redis, { scope: "pay", subjectId: "u1", requestId: "req1" }, async () => {
      throw new Error("provider down");
    }),
  );
  const result = await tryClaim(redis, { scope: "pay", subjectId: "u1", requestId: "req1" }, async () => "ok");
  assert.equal(result, "ok");
});

test("tryClaim: конкурентный вызов во время выполнения → конфликт", async () => {
  const redis = fakeRedis();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => (release = r));
  const first = tryClaim(redis, { scope: "pay", subjectId: "u1", requestId: "req1" }, async () => {
    await gate;
    return "done";
  });
  await assert.rejects(
    tryClaim(redis, { scope: "pay", subjectId: "u1", requestId: "req1" }, async () => "second"),
    (e: unknown) => e instanceof IdempotencyConflictError,
  );
  release!();
  assert.equal(await first, "done");
});

test("маскирование: telegram-токен в URL и секретные поля", () => {
  assert.equal(maskUrl("https://api.telegram.org/bot123456:AAH-secret/sendMessage"), "https://api.telegram.org/bot***/sendMessage");
  const masked = maskBody({ api_key: "supersecretvalue", amount: 100, nested: { token: "abcdefghij" } }) as Record<string, unknown>;
  assert.notEqual(masked.api_key, "supersecretvalue");
  assert.equal(masked.amount, 100);
  assert.notEqual((masked.nested as Record<string, unknown>).token, "abcdefghij");
});

test("maskValue: короткие значения полностью скрыты", () => {
  assert.equal(maskValue("short"), "***");
  assert.ok(maskValue("averylongsecretvalue").includes("***"));
});

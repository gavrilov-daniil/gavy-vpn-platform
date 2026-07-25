import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecutionContext } from "@nestjs/common";
import { RateLimitGuard } from "./rate-limit.guard.js";
import type { RateLimitDecision, RateLimitRule, RateLimitService } from "./rate-limit.service.js";

interface Seen {
  key: string;
  rule: RateLimitRule;
}

/** Лимитер-заглушка: сам по себе он покрыт rate-limit.test.ts, здесь важна раскладка ключей. */
function limiterStub(decide: (key: string) => RateLimitDecision, seen: Seen[]): RateLimitService {
  return {
    check(key: string, rule: RateLimitRule) {
      seen.push({ key, rule });
      return Promise.resolve(decide(key));
    },
  } as unknown as RateLimitService;
}

const allow = (): RateLimitDecision => ({ allowed: true, retryAfterSec: 0 });
const deny = (): RateLimitDecision => ({ allowed: false, retryAfterSec: 42 });

function context(path: string, body?: unknown, ip = "203.0.113.7") {
  const responseHeaders: Record<string, string> = {};
  const req = {
    path,
    url: path,
    body,
    headers: { "x-forwarded-for": ip },
    socket: { remoteAddress: ip },
  };
  const res = {
    setHeader(name: string, value: string) {
      responseHeaders[name.toLowerCase()] = value;
    },
  };
  const ctx = {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, responseHeaders };
}

async function keysFor(path: string, body?: unknown): Promise<string[]> {
  const seen: Seen[] = [];
  const guard = new RateLimitGuard(limiterStub(allow, seen));
  assert.equal(await guard.canActivate(context(path, body).ctx), true);
  return seen.map((s) => s.key);
}

describe("RateLimitGuard: раскладка по разделам", () => {
  it("публичная выдача и health не трогаются — их лимит живёт в SubscriptionService", async () => {
    assert.deepEqual(await keysFor("/auto/abcdef123456"), []);
    assert.deepEqual(await keysFor("/api/sub/00000000-0000-0000-0000-000000000001"), []);
    assert.deepEqual(await keysFor("/healthz"), []);
    assert.deepEqual(await keysFor("/v1/plans"), []);
  });

  it("вход в админку считается и по IP, и по учётке", async () => {
    assert.deepEqual(await keysFor("/api/admin/auth/login", { email: "OPS@Example.com ", password: "x" }), [
      "admin-login:ip:203.0.113.7",
      "admin-login:email:ops@example.com",
    ]);
  });

  it("вход без email в теле всё равно упирается в лимит по IP", async () => {
    assert.deepEqual(await keysFor("/api/admin/auth/login", {}), ["admin-login:ip:203.0.113.7"]);
    assert.deepEqual(await keysFor("/api/admin/auth/login", undefined), ["admin-login:ip:203.0.113.7"]);
  });

  it("остальной админский API, вебхуки и /internal/* — каждый в своём окне", async () => {
    assert.deepEqual(await keysFor("/api/admin/subscribers"), ["admin:ip:203.0.113.7"]);
    assert.deepEqual(await keysFor("/webhooks/oxapay"), ["webhook:ip:203.0.113.7"]);
    assert.deepEqual(await keysFor("/internal/agent/nodes/x/desired-state"), ["internal:ip:203.0.113.7"]);
  });

  it("смена регистра в пути не выводит из-под лимита (Express матчит роут без учёта регистра)", async () => {
    assert.deepEqual(await keysFor("/API/Admin/Auth/Login", { email: "a@b.c" }), [
      "admin-login:ip:203.0.113.7",
      "admin-login:email:a@b.c",
    ]);
    assert.deepEqual(await keysFor("/Internal/Agent/enroll"), ["internal:ip:203.0.113.7"]);
  });

  it("превышение — 429 с retry-after, следующие правила уже не считаются", async () => {
    const seen: Seen[] = [];
    const guard = new RateLimitGuard(limiterStub(deny, seen));
    const { ctx, responseHeaders } = context("/api/admin/auth/login", { email: "a@b.c", password: "x" });

    await assert.rejects(
      () => guard.canActivate(ctx),
      (err: { getStatus(): number; getResponse(): { retryAfterSec: number } }) => {
        assert.equal(err.getStatus(), 429);
        assert.equal(err.getResponse().retryAfterSec, 42);
        return true;
      },
    );

    assert.equal(responseHeaders["retry-after"], "42");
    assert.deepEqual(seen.map((s) => s.key), ["admin-login:ip:203.0.113.7"]);
  });
});

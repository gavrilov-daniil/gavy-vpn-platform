/**
 * Источник адреса клиента — фундамент всех лимитов по IP. Ошибка здесь не ломает
 * ничего видимого: барьеры просто перестают считать, и это заметно только по факту
 * успешного перебора.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Request } from "express";
import { clientIp } from "./client-ip.js";

function request(headers: Record<string, string>, remoteAddress = "198.51.100.9"): Request {
  return { headers, socket: { remoteAddress } } as unknown as Request;
}

describe("clientIp: за доверенным прокси", () => {
  it("берёт правый хоп — его дописал наш прокси, а не клиент", () => {
    const req = request({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" });
    assert.equal(clientIp(req, true), "203.0.113.7");
  });

  it("подделанный заголовок не даёт нового ключа лимита на каждый запрос", () => {
    const forged = ["1.1.1.1", "2.2.2.2", "3.3.3.3"].map((fake) =>
      clientIp(request({ "x-forwarded-for": `${fake}, 203.0.113.7` }), true),
    );
    assert.deepEqual(forged, ["203.0.113.7", "203.0.113.7", "203.0.113.7"], "иначе лимиты по IP не работают вовсе");
  });

  it("единственный хоп — он же и правый", () => {
    assert.equal(clientIp(request({ "x-forwarded-for": "203.0.113.7" }), true), "203.0.113.7");
  });

  it("пробелы и регистр не создают второй ключ на того же клиента", () => {
    assert.equal(clientIp(request({ "x-forwarded-for": "1.2.3.4 ,  203.0.113.7  " }), true), "203.0.113.7");
    assert.equal(clientIp(request({ "x-forwarded-for": "2001:DB8::1" }), true), "2001:db8::1");
  });

  it("без заголовка падает на socket-адрес, а не на «unknown» для всех разом", () => {
    assert.equal(clientIp(request({}), true), "198.51.100.9");
    assert.equal(clientIp(request({ "x-forwarded-for": "   " }), true), "198.51.100.9");
  });
});

describe("clientIp: без доверия прокси", () => {
  it("заголовок игнорируется целиком", () => {
    const req = request({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" });
    assert.equal(clientIp(req, false), "198.51.100.9");
  });

  it("IPv4-mapped IPv6 и голый IPv4 — один и тот же клиент", () => {
    assert.equal(clientIp(request({}, "::ffff:198.51.100.9"), false), "198.51.100.9");
  });

  it("нет ни заголовка, ни socket-адреса — общий ключ, но не пустой", () => {
    const req = { headers: {}, socket: {} } as unknown as Request;
    assert.equal(clientIp(req, true), "unknown");
  });
});

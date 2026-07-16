import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleBase, buildProfileConfig, projectVariants } from "./builder.js";
import { validateConfig } from "./validate.js";
import type { GeneratorInput, ProfileInput } from "./types.js";

function fixture(): GeneratorInput {
  const reality = { sni: "ads.x5.ru", fingerprint: "firefox", flow: "xtls-rprx-vision" };
  return {
    vlessUuid: "11111111-1111-1111-1111-111111111111",
    front: {
      tag: "frontru2",
      host: { address: "10.0.0.9", port: 8443, pbk: "PBK_FRONT", sid: "aa11", ...reality },
    },
    domainList: {
      zones: ["ru", "su", "xn--p1ai"],
      domains: ["domain:vk.com", "domain:yandex.ru"],
      ipCidrs: ["77.88.0.0/18"],
    },
    channels: [
      { kind: "direct", tag: "de-direct", cc: "DE", host: { address: "1.1.1.1", port: 443, pbk: "PBK_DE", sid: "de01", ...reality } },
      { kind: "direct", tag: "pl-direct", cc: "PL", host: { address: "2.2.2.2", port: 443, pbk: "PBK_PL", sid: "pl01", ...reality } },
      { kind: "cascade", tag: "pl-cascade", cc: "PL", host: { address: "2.2.2.2", port: 443, pbk: "PBK_PL", sid: "pl01", ...reality } },
    ],
  };
}

test("assembleBase проходит инвариант-валидатор", () => {
  const cfg = assembleBase(fixture());
  const res = validateConfig(cfg);
  assert.deepEqual(res.errors, []);
  assert.ok(res.ok);
});

test("двухтирный профиль: loopback-цепочка целостна, последний tier без fallbackTag", () => {
  const input = fixture();
  const profile: ProfileInput = { remark: "🇵🇱 Польша", primary: ["pl-direct"], fallback: ["pl-cascade"] };
  const cfg = buildProfileConfig(input, profile) as any;
  assert.equal(validateConfig(cfg).ok, true);

  const tier1 = cfg.routing.balancers.find((b: any) => b.tag === "tier1");
  const tier2 = cfg.routing.balancers.find((b: any) => b.tag === "tier2");
  assert.equal(tier1.fallbackTag, "lo-out-1");
  assert.equal(tier2.fallbackTag, undefined); // последний tier — без fallback
  assert.ok(cfg.inbounds.some((i: any) => i.tag === "lo-in-1" && i.port === 0 && i.listen === "127.0.0.1"));
});

test("single-tier профиль (только cascade, как FI) — балансер без fallback, без loopback", () => {
  const input = fixture();
  const profile: ProfileInput = { remark: "🇫🇮 Финляндия", primary: ["pl-cascade"], fallback: [] };
  const cfg = buildProfileConfig(input, profile) as any;
  assert.equal(validateConfig(cfg).ok, true);
  assert.equal(cfg.routing.balancers.length, 1);
  assert.equal(cfg.routing.balancers[0].fallbackTag, undefined);
  assert.ok(!cfg.inbounds.some((i: any) => i.tag === "lo-in-1"));
});

test("cascade-канал несёт dialerProxy=front, оба плеча flow=vision", () => {
  const input = fixture();
  const cfg = buildProfileConfig(input, { remark: "PL", primary: ["pl-direct"], fallback: ["pl-cascade"] }) as any;
  const clone = cfg.outbounds.find((o: any) => o.tag === "pl-cascade");
  const front = cfg.outbounds.find((o: any) => o.tag === "frontru2");
  assert.equal(clone.streamSettings.sockopt.dialerProxy, "frontru2");
  assert.equal(clone.settings.vnext[0].users[0].flow, "xtls-rprx-vision");
  assert.equal(front.settings.vnext[0].users[0].flow, "xtls-rprx-vision");
});

test("валидатор ловит geoip: в конфиге", () => {
  const cfg = assembleBase(fixture()) as any;
  cfg.routing.rules.push({ type: "field", ip: ["geoip:ru"], outboundTag: "freedom" });
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("geoip")));
});

test("валидатор ловит последний tier с fallbackTag (петля реинжекта)", () => {
  const input = fixture();
  const cfg = buildProfileConfig(input, { remark: "PL", primary: ["pl-direct"], fallback: ["pl-cascade"] }) as any;
  cfg.routing.balancers.find((b: any) => b.tag === "tier2").fallbackTag = "lo-out-1";
  const res = validateConfig(cfg);
  assert.equal(res.ok, false);
});

test("projectVariants отдаёт массив с remark на профиль", () => {
  const input = fixture();
  const profiles: ProfileInput[] = [
    { remark: "🔀 Авто", isAuto: true, primary: ["de-direct", "pl-direct"], fallback: ["pl-cascade"] },
    { remark: "🇩🇪 Германия", primary: ["de-direct"], fallback: [] },
  ];
  const rendered = projectVariants(input, profiles);
  assert.equal(rendered.length, 2);
  assert.equal(rendered[0].remark, "🔀 Авто");
  assert.ok(rendered.every((r) => validateConfig(r.config).ok));
});

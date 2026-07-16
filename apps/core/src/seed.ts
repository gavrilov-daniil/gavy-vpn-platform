/**
 * Демо-seed для M0: делает GET /auto/<SHORT_UUID> реально работающим и даёт харнесс спайку 1
 * (golden byte-diff нового генератора против Remnawave). Идемпотентен (onConflictDoNothing).
 *
 * Запуск:  DATABASE_URL=... pnpm --filter @vpn/core seed
 * Проверка: curl -H "User-Agent: Happ/1" localhost:3100/auto/demoshortuuid0001 | jq .
 */
import { createDb, schema } from "@vpn/db";

const ORG = "00000000-0000-0000-0000-000000000001";
const SHORT_UUID = "demoshortuuid0001";
const id = (n: string) => `00000000-0000-0000-0000-0000000000${n}`;

const reality = { sni: "ads.x5.ru", fingerprint: "firefox", flow: "xtls-rprx-vision" };

async function main() {
  const db = createDb();

  await db.insert(schema.organization).values({ id: ORG, slug: "gavy", name: "Gavy VPN" }).onConflictDoNothing();

  await db.insert(schema.subscriber).values({
    id: id("a1"), orgId: ORG, telegramId: 1001, username: "demo", status: "active",
  }).onConflictDoNothing();

  await db.insert(schema.subscription).values({
    id: id("b1"), orgId: ORG, subscriberId: id("a1"),
    shortUuid: SHORT_UUID, status: "active",
    vlessUuid: "11111111-1111-1111-1111-111111111111",
    trafficLimitBytes: 100 * 1024 ** 3, usedTrafficBytes: 5 * 1024 ** 3,
  }).onConflictDoNothing();

  await db.insert(schema.server).values({
    id: id("c1"), orgId: ORG, hostname: "seed-exit", primaryIp: "203.0.113.10", country: "DE",
  }).onConflictDoNothing();
  await db.insert(schema.configProfile).values({ id: id("d1"), orgId: ORG, name: "seed-profile" }).onConflictDoNothing();
  await db.insert(schema.node).values({
    id: id("e1"), orgId: ORG, serverId: id("c1"), configProfileId: id("d1"),
    name: "seed-node", roles: ["exit", "front"], status: "active",
  }).onConflictDoNothing();
  await db.insert(schema.inbound).values({
    id: id("f1"), orgId: ORG, configProfileId: id("d1"), tag: "VLESS_REALITY_SEED", port: 443, ...reality,
  }).onConflictDoNothing();

  // hosts: два exit-endpoint'а + RU-front (tagPrefix "front")
  await db.insert(schema.host).values([
    { id: id("11"), orgId: ORG, inboundId: id("f1"), nodeId: id("e1"), remark: "DE", address: "203.0.113.10", port: 443, pbk: "PBK_DE", sid: "de01", ...reality },
    { id: id("12"), orgId: ORG, inboundId: id("f1"), nodeId: id("e1"), remark: "PL", address: "203.0.113.20", port: 443, pbk: "PBK_PL", sid: "pl01", ...reality },
    { id: id("13"), orgId: ORG, inboundId: id("f1"), nodeId: id("e1"), remark: "RU-front", address: "203.0.113.30", port: 8443, pbk: "PBK_FRONT", sid: "fr01", tagPrefix: "front", ...reality },
  ]).onConflictDoNothing();

  // каналы: de-direct, pl-direct, pl-cascade (клон pl-exit с dialerProxy=front)
  await db.insert(schema.channel).values([
    { id: id("21"), orgId: ORG, kind: "direct", tag: "de-direct", cc: "DE", hostId: id("11") },
    { id: id("22"), orgId: ORG, kind: "direct", tag: "pl-direct", cc: "PL", hostId: id("12") },
    { id: id("23"), orgId: ORG, kind: "cascade", tag: "pl-cascade", newTag: "pl-cascade", cc: "PL", hostId: id("12") },
  ]).onConflictDoNothing();

  // профили: Авто (все) + Польша (direct→cascade failover)
  await db.insert(schema.profile).values([
    { id: id("31"), orgId: ORG, remark: "🔀 Авто", sortOrder: 0, isAuto: true },
    { id: id("32"), orgId: ORG, remark: "🇵🇱 Польша", sortOrder: 1 },
  ]).onConflictDoNothing();
  await db.insert(schema.profileChannel).values([
    { id: id("41"), orgId: ORG, profileId: id("31"), channelId: id("21"), tier: 1, sortOrder: 0 },
    { id: id("42"), orgId: ORG, profileId: id("31"), channelId: id("22"), tier: 1, sortOrder: 1 },
    { id: id("43"), orgId: ORG, profileId: id("31"), channelId: id("23"), tier: 2, sortOrder: 0 },
    { id: id("44"), orgId: ORG, profileId: id("32"), channelId: id("22"), tier: 1, sortOrder: 0 },
    { id: id("45"), orgId: ORG, profileId: id("32"), channelId: id("23"), tier: 2, sortOrder: 0 },
  ]).onConflictDoNothing();

  // список РФ-доменов (минимальный)
  await db.insert(schema.routingDomainList).values({
    id: id("51"), orgId: ORG, name: "ru_direct", version: 1, sourceUrl: "seed",
  }).onConflictDoNothing();
  await db.insert(schema.routingDomainEntry).values([
    { id: id("61"), listId: id("51"), kind: "domain", value: "ru" },
    { id: id("62"), listId: id("51"), kind: "domain", value: "su" },
    { id: id("63"), listId: id("51"), kind: "domain", value: "xn--p1ai" },
    { id: id("64"), listId: id("51"), kind: "domain", value: "vk.com" },
    { id: id("65"), listId: id("51"), kind: "domain", value: "yandex.ru" },
    { id: id("66"), listId: id("51"), kind: "cidr", value: "77.88.0.0/18" },
  ]).onConflictDoNothing();

  console.log(`seed ok → GET /auto/${SHORT_UUID}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

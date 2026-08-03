import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { schema } from "@corelink/db";
import { StatsService } from "./stats.service.js";
import { TEST_ORG_ID, cleanupOrg, closeDb, createSubscriber, createSubscription, openDb, seedNetwork } from "../testing/fixtures.test.js";

const db = openDb();
const stats = new StatsService(db);

let network: Awaited<ReturnType<typeof seedNetwork>>;
let shortUuidA: string;
let shortUuidB: string;

/** Тот же формат, что у колонки `day`. */
function dayOffset(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

before(async () => {
  network = await seedNetwork(db, {
    channels: [{ key: "de", kind: "direct", tag: "DE" }],
    profiles: [{ remark: "🇩🇪 Германия", primary: ["de"] }],
  });

  const subscriber = await createSubscriber(db);
  const a = await createSubscription(db, subscriber.id, { status: "active" });
  const b = await createSubscription(db, subscriber.id, { status: "active" });
  shortUuidA = a.shortUuid;
  shortUuidB = b.shortUuid;

  await db.insert(schema.trafficDaily).values([
    { orgId: TEST_ORG_ID, day: dayOffset(1), subjectType: "user", subjectKey: shortUuidA, nodeId: network.node.id, up: 1000, down: 4000 },
    { orgId: TEST_ORG_ID, day: dayOffset(2), subjectType: "user", subjectKey: shortUuidA, nodeId: network.node.id, up: 500, down: 1500 },
    { orgId: TEST_ORG_ID, day: dayOffset(1), subjectType: "user", subjectKey: shortUuidB, nodeId: network.node.id, up: 100, down: 200 },
    // Тот же трафик, посчитанный Xray со стороны inbound'а: в сводку попадать НЕ должен
    { orgId: TEST_ORG_ID, day: dayOffset(1), subjectType: "inbound", subjectKey: "VLESS_REALITY_TEST", nodeId: network.node.id, up: 1100, down: 4200 },
    // За пределами окна: не должен попасть в 7-дневную сводку
    { orgId: TEST_ORG_ID, day: dayOffset(40), subjectType: "user", subjectKey: shortUuidA, nodeId: network.node.id, up: 9_000_000, down: 9_000_000 },
  ]);

  await db.insert(schema.subscriberDevice).values([
    { orgId: TEST_ORG_ID, subscriptionId: a.id, hwid: "hw-1", deviceOs: "iOS", osVer: "18.2", deviceModel: "iPhone 15" },
    { orgId: TEST_ORG_ID, subscriptionId: a.id, hwid: "hw-2", deviceOs: "Android", osVer: "15", deviceModel: "Pixel 8" },
    { orgId: TEST_ORG_ID, subscriptionId: b.id, hwid: "hw-3", deviceOs: "iOS", osVer: "17.5", deviceModel: "iPad" },
    // Клиент, не приславший x-hwid: отдельная категория, а не «прочее»
    { orgId: TEST_ORG_ID, subscriptionId: b.id, hwid: "hw-4", deviceOs: null },
  ]);
});

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

describe("StatsService.overview", () => {
  it("считает только subject_type=user: inbound дублирует те же байты", async () => {
    const result = await stats.overview(7);

    // 1000+4000 + 500+1500 + 100+200 = 7300; с inbound'ом было бы 12 600
    assert.equal(Number(result.traffic.up) + Number(result.traffic.down), 7300);
    assert.equal(result.traffic.subscribers, 2);
  });

  it("окно периода отсекает старые дни", async () => {
    const week = await stats.overview(7);
    const year = await stats.overview(365);

    assert.equal(Number(week.traffic.up) + Number(week.traffic.down), 7300);
    assert.equal(Number(year.traffic.up) + Number(year.traffic.down), 7300 + 18_000_000);
  });

  it("разрез по нодам отдаёт страну сервера", async () => {
    const result = await stats.overview(7);
    const node = result.traffic.byNode.find((n) => n.nodeId === network.node.id);

    assert.ok(node, "нода с трафиком обязана быть в разрезе");
    assert.equal(node.country, "DE");
    assert.equal(Number(node.up) + Number(node.down), 7300);
  });

  it("по дням трафик разложен по возрастанию даты", async () => {
    const result = await stats.overview(7);
    const days = result.traffic.byDay.map((d) => d.day);

    assert.deepEqual(days, [...days].sort());
    assert.equal(result.traffic.byDay.length, 2);
  });

  it("платформы считаются устройствами, а не байтами; клиент без hwid — отдельная категория", async () => {
    const result = await stats.overview(7);

    assert.equal(result.devices.total, 4);
    const ios = result.devices.byPlatform.find((p) => p.os === "iOS");
    assert.equal(ios?.devices, 2);
    assert.equal(ios?.subscriptions, 2);
    assert.ok(
      result.devices.byPlatform.some((p) => p.os === null),
      "устройство без device_os обязано быть видно отдельно, а не потеряться",
    );
    assert.equal(
      Object.keys(result.devices).includes("up"),
      false,
      "байтов по устройствам нет и быть не может: Xray считает трафик по email подписки",
    );
  });
});

describe("StatsService.topSubscribers", () => {
  it("сортирует по сумме трафика и находит подписку по short_uuid", async () => {
    const top = await stats.topSubscribers(7, 10);

    assert.equal(top[0]?.shortUuid, shortUuidA);
    assert.equal(Number(top[0]?.up) + Number(top[0]?.down), 7000);
    assert.ok(top[0]?.subscriptionId, "подписка должна подтянуться джойном");
    assert.equal(top[1]?.shortUuid, shortUuidB);
  });

  it("limit ограничивает выдачу", async () => {
    const top = await stats.topSubscribers(7, 1);
    assert.equal(top.length, 1);
  });
});

describe("StatsService.devicesBySubscription", () => {
  it("отдаёт устройства своей подписки и не смешивает с чужими", async () => {
    const devices = await stats.devicesBySubscription(shortUuidA);

    assert.equal(devices.length, 2);
    assert.deepEqual(devices.map((d) => d.hwid).sort(), ["hw-1", "hw-2"]);
    assert.ok(devices.every((d) => d.lastSeenAt instanceof Date));
  });
});

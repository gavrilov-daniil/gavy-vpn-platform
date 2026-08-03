/**
 * Импорт с действующей панели.
 *
 * Оба сценария здесь — молчаливые отказы: панель рапортует успех, а клиент
 * остаётся без VPN. Первый — squad без inbound'ов (конфиг есть, на ноде юзера нет),
 * второй — вторая подписка у клиента, зашедшего в бота до импорта (оплата
 * продлевает одну строку, Happ ходит по другой).
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { TEST_ORG_ID, cleanupOrg, closeDb, createSubscriber, createSubscription, openDb } from "../testing/fixtures.test.js";
import { InfraService } from "../nodes/infra.service.js";
import { NodeStateService } from "../nodes/node-state.service.js";
import { InfraImportService } from "./infra-import.service.js";
import { RemnawaveImportService } from "./remnawave-import.service.js";
import { fakePanel as panelClient, panelData, panelUser } from "./panel.fixtures.test.js";
import type { RemnawaveClient, RemnawaveSquad, RemnawaveUser } from "./remnawave.client.js";

let db: Database;
let importer: RemnawaveImportService;

before(() => {
  db = openDb();
  importer = new RemnawaveImportService(db, new InfraImportService(db, new InfraService(db, new NodeStateService(db))));
});

beforeEach(() => cleanupOrg(db));

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

/** Панель без инфраструктуры: ноды/профили/host'ы пусты, проверяется только слой юзеров. */
function fakePanel(input: { squads?: RemnawaveSquad[]; users?: RemnawaveUser[] }): RemnawaveClient {
  return panelClient({ squads: input.squads ?? [], users: input.users ?? [] });
}

function panelSquad(name: string, tags: string[]): RemnawaveSquad {
  return {
    uuid: randomUUID(),
    name,
    inbounds: tags.map((tag) => ({ uuid: randomUUID(), tag, profileUuid: randomUUID(), type: "vless", port: 443 })),
  };
}

/** config_profile + inbound'ы с боевыми тегами: связывание идёт именно по тегу. */
async function seedInbounds(tags: string[]) {
  const [profile] = await db
    .insert(schema.configProfile)
    .values({ orgId: TEST_ORG_ID, name: `cfg-${randomUUID().slice(0, 8)}` })
    .returning();
  const rows = [];
  for (const tag of tags) {
    const [inbound] = await db
      .insert(schema.inbound)
      .values({ orgId: TEST_ORG_ID, configProfileId: profile.id, tag, port: 443 })
      .returning();
    rows.push(inbound);
  }
  return rows;
}

async function squadInboundsOf(squadName: string) {
  const [squad] = await db
    .select()
    .from(schema.squad)
    .where(and(eq(schema.squad.orgId, TEST_ORG_ID), eq(schema.squad.name, squadName)));
  if (!squad) return [];
  return db
    .select({ tag: schema.inbound.tag })
    .from(schema.squadInbound)
    .innerJoin(schema.inbound, eq(schema.squadInbound.inboundId, schema.inbound.id))
    .where(eq(schema.squadInbound.squadId, squad.id));
}

async function subscriptionsOf(subscriberId: string) {
  return db
    .select()
    .from(schema.subscription)
    .where(and(eq(schema.subscription.orgId, TEST_ORG_ID), eq(schema.subscription.subscriberId, subscriberId)));
}

describe("RemnawaveImportService: состав squad'ов", () => {
  it("переносит inbound'ы squad'а — иначе подписка не попадает в desired-state ноды", async () => {
    await seedInbounds(["VLESS_REALITY_DE", "VLESS_REALITY_FI"]);
    const squad = panelSquad("all-servers", ["VLESS_REALITY_DE", "VLESS_REALITY_FI", "VLESS_REALITY_NOT_MIGRATED"]);
    const user = panelUser({ activeInternalSquads: [{ uuid: squad.uuid, name: squad.name }] });

    const report = await importer.runWith(fakePanel({ squads: [squad], users: [user] }), { dryRun: false });

    assert.deepEqual(
      (await squadInboundsOf("all-servers")).map((r) => r.tag).sort(),
      ["VLESS_REALITY_DE", "VLESS_REALITY_FI"],
      "squad обязан открывать те же inbound'ы, что и в панели",
    );
    assert.deepEqual(report.squadInbounds, { total: 3, created: 2 });
    assert.equal(report.subscriptionsWithoutSquad, 0);
    assert.ok(
      report.warnings.some((w) => w.includes("VLESS_REALITY_NOT_MIGRATED")),
      "про inbound, которого у нас нет, оператор должен узнать до cutover",
    );
  });

  it("squad, не связанный ни с одним inbound'ом, попадает в warnings, а не в «успех»", async () => {
    await seedInbounds(["VLESS_REALITY_DE"]);
    const squad = panelSquad("cascades", ["RU2_RELAY_IN", "RU1A_RELAY_IN"]);
    const user = panelUser({ activeInternalSquads: [{ uuid: squad.uuid, name: squad.name }] });

    const report = await importer.runWith(fakePanel({ squads: [squad], users: [user] }), { dryRun: false });

    assert.equal(report.squads.created, 1, "squad создан — по одному этому счётчику импорт выглядит успешным");
    assert.equal(report.squadInbounds.created, 0);
    assert.deepEqual(await squadInboundsOf("cascades"), []);
    assert.ok(
      report.warnings.some((w) => w.includes("cascades") && w.includes("тихий провал")),
      "пустой squad обязан быть назван провалом миграции, а не частичным успехом",
    );
  });

  it("подписка без squad'ов считается отдельно: конфиг есть, доступа к нодам нет", async () => {
    await seedInbounds(["VLESS_REALITY_DE"]);
    const squad = panelSquad("all-servers", ["VLESS_REALITY_DE"]);
    const report = await importer.runWith(
      fakePanel({
        squads: [squad],
        users: [
          panelUser({ activeInternalSquads: [{ uuid: squad.uuid, name: squad.name }] }),
          panelUser({ activeInternalSquads: [] }),
        ],
      }),
      { dryRun: false },
    );

    assert.equal(report.subscriptionsWithoutSquad, 1);
    assert.ok(report.warnings.some((w) => w.includes("подписок без единого squad'а: 1")));
  });

  it("dry-run считает связи, но ничего не пишет", async () => {
    await seedInbounds(["VLESS_REALITY_DE", "VLESS_REALITY_FI"]);
    const squad = panelSquad("all-servers", ["VLESS_REALITY_DE", "VLESS_REALITY_FI"]);
    const user = panelUser({ activeInternalSquads: [{ uuid: squad.uuid, name: squad.name }] });

    const report = await importer.runWith(fakePanel({ squads: [squad], users: [user] }), {});

    assert.equal(report.dryRun, true);
    assert.deepEqual(report.squadInbounds, { total: 2, created: 2 });
    assert.equal(report.users.created, 1);
    assert.deepEqual(await squadInboundsOf("all-servers"), []);
    assert.equal(
      (await db.select().from(schema.squad).where(eq(schema.squad.orgId, TEST_ORG_ID))).length,
      0,
      "dry-run не имеет права писать в БД",
    );
  });
});

describe("RemnawaveImportService: сквозной прогон с инфраструктурой", () => {
  /** Панель целиком: ноды с inbound'ами, host'ы, squad'ы и юзер. Наша БД пуста. */
  const panel = () =>
    panelData({
      profiles: [
        {
          name: "de-direct-reality",
          inbounds: [{ tag: "VLESS_REALITY_DE" }, { tag: "VLESS_XHTTP_WL_DE", network: "xhttp", security: "none" }],
          nodes: [{ name: "de-asd", address: "195.66.24.14", cc: "DE", active: ["VLESS_REALITY_DE"] }],
        },
        {
          name: "ru2-cascade-fi",
          inbounds: [{ tag: "RU2_RELAY_IN" }],
          nodes: [{ name: "ru2-relay", address: "194.156.118.194", cc: "RU" }],
        },
      ],
      hosts: [{ remark: "Gavy VPN", address: "195.66.24.14", tag: "VLESS_REALITY_DE" }],
      squads: [
        { name: "all-servers", tags: ["VLESS_REALITY_DE", "RU2_RELAY_IN", "VLESS_XHTTP_WL_DE"] },
        { name: "cascades", tags: ["RU2_RELAY_IN"] },
      ],
    });

  it("связывает squad'ы с перенесёнными inbound'ами — ради этого импорт нод и делался", async () => {
    const data = panel();
    const user = panelUser({
      activeInternalSquads: data.squads.map((s) => ({ uuid: s.uuid, name: s.name })),
    });

    const report = await importer.runWith(panelClient({ ...data, users: [user] }), { dryRun: false });

    assert.equal(report.nodes.created, 2, "ноды переносит тот же прогон — оператору их заводить не нужно");
    assert.equal(report.inbounds.created, 2);
    assert.equal(report.hosts.created, 1);
    assert.deepEqual(
      (await squadInboundsOf("all-servers")).map((r) => r.tag).sort(),
      ["RU2_RELAY_IN", "VLESS_REALITY_DE"],
      "без этих связей клиент получает конфиг, которого нет ни на одной ноде",
    );
    assert.deepEqual((await squadInboundsOf("cascades")).map((r) => r.tag), ["RU2_RELAY_IN"]);
    assert.deepEqual(report.squadInbounds, { total: 4, created: 3 });
    assert.equal(report.subscriptionsWithoutSquad, 0);
    assert.ok(
      report.warnings.some((w) => w.includes("VLESS_XHTTP_WL_DE")),
      "не-reality inbound не переносится — и squad про него должен пожаловаться",
    );
  });

  it("dry-run считает будущие связи, а не ноль: инбаундов ещё нет ни одного", async () => {
    const data = panel();
    const report = await importer.runWith(panelClient({ ...data, users: [panelUser()] }), {});

    assert.equal(report.dryRun, true);
    assert.deepEqual(report.squadInbounds, { total: 4, created: 3 });
    assert.equal(
      (await db.select().from(schema.node).where(eq(schema.node.orgId, TEST_ORG_ID))).length,
      0,
      "dry-run не имеет права писать в БД",
    );
    assert.equal((await db.select().from(schema.squadInbound)).some((r) => r.inboundId.startsWith("plan:")), false);
  });
});

describe("RemnawaveImportService: подписка, заведённая ботом до импорта", () => {
  it("переносит идентичность панели в ботовую подписку, а не создаёт вторую", async () => {
    const telegramId = Math.floor(Math.random() * 2 ** 40);
    const subscriber = await createSubscriber(db, { telegramId });
    const botSubscription = await createSubscription(db, subscriber.id, { status: "inactive" });

    const user = panelUser({ telegramId, status: "ACTIVE" });
    const report = await importer.runWith(fakePanel({ users: [user] }), { dryRun: false });

    const rows = await subscriptionsOf(subscriber.id);
    assert.equal(rows.length, 1, "у клиента обязана остаться одна подписка, иначе оплата уйдёт не в ту");
    assert.equal(rows[0].id, botSubscription.id, "переносим идентичность в существующую строку, а не заводим новую");
    assert.equal(rows[0].shortUuid, user.shortUuid, "клиент ходит по ссылке панели — short_uuid обязан стать её");
    assert.equal(rows[0].vlessUuid, user.vlessUuid);
    assert.equal(rows[0].status, "active");
    assert.equal(report.users.adopted, 1);
    assert.equal(report.users.created, 0);
  });

  it("законная вторая подписка не страдает: два аккаунта панели на один telegram_id", async () => {
    const telegramId = Math.floor(Math.random() * 2 ** 40);
    const subscriber = await createSubscriber(db, { telegramId });
    await createSubscription(db, subscriber.id, { status: "inactive" });

    const first = panelUser({ telegramId });
    const second = panelUser({ telegramId });
    const report = await importer.runWith(fakePanel({ users: [first, second] }), { dryRun: false });

    const rows = await subscriptionsOf(subscriber.id);
    assert.equal(rows.length, 2, "второй аккаунт панели — это вторая подписка, а не перезапись первой");
    assert.deepEqual(
      rows.map((r) => r.shortUuid).sort(),
      [first.shortUuid, second.shortUuid].sort(),
      "обе идентичности панели обязаны сохраниться дословно",
    );
    assert.equal(report.users.adopted, 1);
    assert.equal(report.users.created, 1);
  });

  it("повторный прогон идемпотентен: ни подписок, ни связей squad→inbound не прибавляется", async () => {
    await seedInbounds(["VLESS_REALITY_DE"]);
    const telegramId = Math.floor(Math.random() * 2 ** 40);
    const subscriber = await createSubscriber(db, { telegramId });
    await createSubscription(db, subscriber.id, { status: "inactive" });

    const squad = panelSquad("all-servers", ["VLESS_REALITY_DE"]);
    const users = [
      panelUser({ telegramId, activeInternalSquads: [{ uuid: squad.uuid, name: squad.name }] }),
      panelUser({ activeInternalSquads: [{ uuid: squad.uuid, name: squad.name }] }),
    ];
    const panel = fakePanel({ squads: [squad], users });

    const first = await importer.runWith(panel, { dryRun: false });
    const afterFirst = {
      subscriptions: (await db.select().from(schema.subscription).where(eq(schema.subscription.orgId, TEST_ORG_ID))).length,
      subscribers: (await db.select().from(schema.subscriber).where(eq(schema.subscriber.orgId, TEST_ORG_ID))).length,
      links: (await squadInboundsOf("all-servers")).length,
    };

    const second = await importer.runWith(panel, { dryRun: false });
    const afterSecond = {
      subscriptions: (await db.select().from(schema.subscription).where(eq(schema.subscription.orgId, TEST_ORG_ID))).length,
      subscribers: (await db.select().from(schema.subscriber).where(eq(schema.subscriber.orgId, TEST_ORG_ID))).length,
      links: (await squadInboundsOf("all-servers")).length,
    };

    assert.equal(first.users.adopted, 1);
    assert.deepEqual(afterSecond, afterFirst, "повторный импорт не имеет права ничего двоить");
    assert.equal(second.users.updated, 2, "во второй раз обе подписки находятся по short_uuid");
    assert.equal(second.users.adopted, 0);
    assert.equal(second.squads.created, 0);
    assert.equal(second.squadInbounds.created, 0);
  });
});

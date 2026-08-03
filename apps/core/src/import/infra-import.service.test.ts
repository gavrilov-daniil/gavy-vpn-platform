/**
 * Перенос инфраструктуры с действующей панели.
 *
 * Всё, что здесь проверяется, ломается молча: расхождение в `pbk`/`sid`/порте не
 * роняет ни импорт, ни ноду — оно роняет хендшейк у клиента, который об этом
 * никому не сообщит. Отдельно закреплены два случая, где импорт мог бы «успешно»
 * сделать не то: повторный прогон, затирающий заведённое оператором, и захват
 * config-профиля, уже принадлежащего другой ноде.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { TEST_ORG_ID, cleanupOrg, closeDb, openDb } from "../testing/fixtures.test.js";
import { InfraService } from "../nodes/infra.service.js";
import { NodeStateService } from "../nodes/node-state.service.js";
import { InfraImportService } from "./infra-import.service.js";
import { emptyReport, type ImportReport } from "./import.report.js";
import { REALITY_VECTOR, fakePanel, panelData, type PanelSpec } from "./panel.fixtures.test.js";

let db: Database;
let importer: InfraImportService;

before(() => {
  db = openDb();
  importer = new InfraImportService(db, new InfraService(db, new NodeStateService(db)));
});

beforeEach(() => cleanupOrg(db));

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

async function runImport(spec: PanelSpec, dryRun = false): Promise<ImportReport> {
  const report = emptyReport(dryRun);
  await importer.run(fakePanel(panelData(spec)), dryRun, report);
  return report;
}

const rows = {
  servers: () => db.select().from(schema.server).where(eq(schema.server.orgId, TEST_ORG_ID)),
  profiles: () => db.select().from(schema.configProfile).where(eq(schema.configProfile.orgId, TEST_ORG_ID)),
  nodes: () => db.select().from(schema.node).where(eq(schema.node.orgId, TEST_ORG_ID)),
  inbounds: () => db.select().from(schema.inbound).where(eq(schema.inbound.orgId, TEST_ORG_ID)),
  hosts: () => db.select().from(schema.host).where(eq(schema.host.orgId, TEST_ORG_ID)),
};

async function counts() {
  return {
    servers: (await rows.servers()).length,
    profiles: (await rows.profiles()).length,
    nodes: (await rows.nodes()).length,
    inbounds: (await rows.inbounds()).length,
    hosts: (await rows.hosts()).length,
  };
}

/** Боевая связка: один профиль панели на три NL-ноды, у каждой поднят свой inbound. */
const SHARED_PROFILE: PanelSpec = {
  profiles: [
    {
      name: "nl-hostkey-reality",
      inbounds: [
        { tag: "VLESS_REALITY_NL1", shortIds: ["91a2d5dcd2cacf2c"] },
        { tag: "VLESS_REALITY_NL2", shortIds: ["5f9ee5fc5383107b"] },
      ],
      nodes: [
        { name: "nl-hk-1", address: "147.90.10.12", cc: "NL", active: ["VLESS_REALITY_NL1"] },
        { name: "nl-hk-2", address: "147.90.10.15", cc: "NL", active: ["VLESS_REALITY_NL2"] },
      ],
    },
  ],
  hosts: [
    { remark: "NL-1", address: "147.90.10.12", tag: "VLESS_REALITY_NL1" },
    { remark: "NL-2", address: "147.90.10.15", tag: "VLESS_REALITY_NL2" },
  ],
};

describe("InfraImportService: состав парка", () => {
  it("режет общий профиль панели по нодам — 1 профиль = 1 нода", async () => {
    const report = await runImport(SHARED_PROFILE);

    assert.deepEqual(await counts(), { servers: 2, profiles: 2, nodes: 2, inbounds: 2, hosts: 2 });
    assert.deepEqual(
      (await rows.profiles()).map((p) => p.name).sort(),
      ["nl-hk-1", "nl-hk-2"],
      "профиль заводится на каждую ноду и называется её именем — это ключ повторного прогона",
    );

    const nodes = await rows.nodes();
    assert.equal(
      new Set(nodes.map((n) => n.configProfileId)).size,
      2,
      "две ноды в одном профиле затёрли бы Reality-ключи друг друга (node_config_profile_uq)",
    );

    // inbound обязан лежать в профиле СВОЕЙ ноды: иначе desired-state поднимет на
    // ноде чужой порт, а балансер уведёт туда трафик
    const inbounds = await rows.inbounds();
    for (const node of nodes) {
      const mine = inbounds.filter((i) => i.configProfileId === node.configProfileId);
      assert.equal(mine.length, 1, `у ноды ${node.name} должен быть ровно свой inbound`);
      assert.equal(mine[0].tag, node.name === "nl-hk-1" ? "VLESS_REALITY_NL1" : "VLESS_REALITY_NL2");
    }

    const hosts = await rows.hosts();
    for (const host of hosts) {
      const owner = nodes.find((n) => n.id === host.nodeId)!;
      const inbound = inbounds.find((i) => i.id === host.inboundId)!;
      assert.equal(inbound.configProfileId, owner.configProfileId, "host обязан смотреть на inbound своей ноды");
    }

    assert.ok(
      report.warnings.some((w) => w.includes("nl-hostkey-reality") && w.includes("общий")),
      "про разрезанный профиль оператор должен узнать из отчёта",
    );
    assert.deepEqual(report.servers, { total: 2, created: 2, updated: 0, skipped: 0 });
    assert.deepEqual(report.configProfiles, { total: 2, created: 2, updated: 0, skipped: 0 });
    assert.deepEqual(report.nodes, { total: 2, created: 2, updated: 0, skipped: 0 });
    assert.deepEqual(report.inbounds, { total: 2, created: 2, updated: 0, skipped: 0 });
    assert.deepEqual(report.hosts, { total: 2, created: 2, updated: 0, skipped: 0 });
  });

  it("две ноды на одной коробке — один сервер", async () => {
    const report = await runImport({
      profiles: [
        {
          name: "ru2-cascade-fi",
          inbounds: [{ tag: "RU2_RELAY_IN" }, { tag: "RU2_FRONT", port: 8443, sniffingEnabled: false }],
          nodes: [{ name: "ru2-relay", address: "194.156.118.194", cc: "RU" }],
        },
        {
          name: "ru2-second",
          inbounds: [{ tag: "RU2_EXTRA", port: 9443 }],
          nodes: [{ name: "ru2-extra", address: "194.156.118.194", cc: "RU" }],
        },
      ],
    });

    assert.equal((await rows.servers()).length, 1, "сервер идентифицируется адресом, а не именем ноды");
    assert.deepEqual(report.servers, { total: 1, created: 1, updated: 1, skipped: 0 });
    assert.deepEqual(
      (await rows.nodes()).map((n) => n.roles).sort(),
      [["exit"], ["relay", "front"]].sort(),
      "роли выводятся из соглашения об именовании тегов",
    );
  });
});

describe("InfraImportService: Reality переносится дословно", () => {
  it("pbk выводится из приватника панели, sid/sni/порт/flow/fingerprint совпадают", async () => {
    await runImport({
      profiles: [
        {
          name: "de-direct-reality",
          inbounds: [
            {
              tag: "VLESS_REALITY_DE",
              port: 443,
              shortIds: ["57ced396c15964fe"],
              serverNames: ["ads.x5.ru"],
              privateKey: REALITY_VECTOR.privateKey,
            },
          ],
          nodes: [{ name: "de-asd", address: "195.66.24.14", cc: "DE" }],
        },
      ],
      hosts: [
        { remark: "Gavy VPN", address: "195.66.24.14", tag: "VLESS_REALITY_DE", fingerprint: "chrome", alpn: "h2" },
        { remark: "DE Direct #2", address: "195.66.24.68", tag: "VLESS_REALITY_DE" },
      ],
    });

    const [inbound] = await rows.inbounds();
    assert.equal(inbound.realityPublicKey, REALITY_VECTOR.publicKey, "pbk обязан совпасть с эталоном RFC 7748");
    assert.deepEqual(inbound.shortIds, ["57ced396c15964fe"]);
    assert.equal(inbound.sni, "ads.x5.ru");
    assert.equal(inbound.port, 443);
    assert.equal(inbound.flow, "xtls-rprx-vision");
    assert.equal(inbound.network, "tcp");
    assert.equal(inbound.security, "reality");

    // приватник живёт на ноде: ни в отдельном поле, ни в сыром ответе панели его быть не должно
    assert.equal(JSON.stringify(inbound.rawJson).includes(REALITY_VECTOR.privateKey), false);
    assert.equal(JSON.stringify(inbound.rawJson).includes("privateKey"), false);
    assert.equal(inbound.realityPrivkeyRef, null);

    const hosts = (await rows.hosts()).sort((a, b) => a.address.localeCompare(b.address));
    assert.deepEqual(
      hosts.map((h) => ({ address: h.address, port: h.port, pbk: h.pbk, sid: h.sid, sni: h.sni, flow: h.flow })),
      [
        {
          address: "195.66.24.14",
          port: 443,
          pbk: REALITY_VECTOR.publicKey,
          sid: "57ced396c15964fe",
          sni: "ads.x5.ru",
          flow: "xtls-rprx-vision",
        },
        {
          address: "195.66.24.68",
          port: 443,
          pbk: REALITY_VECTOR.publicKey,
          sid: "57ced396c15964fe",
          sni: "ads.x5.ru",
          flow: "xtls-rprx-vision",
        },
      ],
      "второй IP — тот же inbound и та же Reality-личность",
    );
    assert.equal(hosts[0].fingerprint, "chrome", "fingerprint берётся из host'а панели: он лежит в конфиге клиента");
    assert.equal(hosts[0].alpn, "h2");
  });

  it("панель не отдала приватник — pbk не выдумывается, а попадает в warnings", async () => {
    const report = await runImport({
      profiles: [
        {
          name: "fi-direct-reality",
          inbounds: [{ tag: "VLESS_REALITY_FI", privateKey: null }],
          nodes: [{ name: "fi-1-asd", address: "45.149.147.163", cc: "FI" }],
        },
      ],
      hosts: [{ remark: "FI exit", address: "45.149.147.163", tag: "VLESS_REALITY_FI" }],
    });

    const [inbound] = await rows.inbounds();
    assert.equal(inbound.realityPublicKey, null, "выдуманный pbk хуже пустого: канал выглядел бы рабочим");
    assert.equal((await rows.hosts())[0].pbk, null);
    assert.ok(report.warnings.some((w) => w.includes("приватник") && w.includes("VLESS_REALITY_FI")));
  });

  it("inbound без порта и не-reality inbound не переносятся, host на них — тоже", async () => {
    const report = await runImport({
      profiles: [
        {
          name: "de-direct-reality",
          inbounds: [
            { tag: "VLESS_REALITY_DE" },
            { tag: "VLESS_XHTTP_WL_DE", network: "xhttp", security: "none", port: 7443 },
            { tag: "VLESS_NO_PORT", noPort: true },
          ],
          nodes: [{ name: "de-asd", address: "195.66.24.14", cc: "DE" }],
        },
      ],
      hosts: [
        { remark: "Gavy VPN", address: "195.66.24.14", tag: "VLESS_REALITY_DE" },
        { remark: "Белые списки", address: "188.72.103.3", tag: "VLESS_XHTTP_WL_DE", sni: "cdn.gavy.shop" },
      ],
    });

    assert.deepEqual((await rows.inbounds()).map((i) => i.tag), ["VLESS_REALITY_DE"]);
    assert.deepEqual((await rows.hosts()).map((h) => h.remark), ["Gavy VPN"]);
    assert.equal(report.inbounds.skipped, 2);
    assert.equal(report.hosts.skipped, 1);
    assert.ok(report.warnings.some((w) => w.includes("VLESS_XHTTP_WL_DE") && w.includes("vless+reality")));
    assert.ok(report.warnings.some((w) => w.includes("VLESS_NO_PORT") && w.includes("порт")));
    assert.ok(report.warnings.some((w) => w.includes("Белые списки") && w.includes("вручную")));
  });

  it("front каскада переносится без endpoint'а — и говорит об этом", async () => {
    const report = await runImport({
      profiles: [
        {
          name: "ru2-cascade-fi",
          inbounds: [{ tag: "RU2_RELAY_IN" }, { tag: "RU2_FRONT", port: 8443, sniffingEnabled: false }],
          nodes: [{ name: "ru2-relay", address: "194.156.118.194", cc: "RU" }],
        },
      ],
      hosts: [{ remark: "RU-FI cascade", address: "194.156.118.194", tag: "RU2_RELAY_IN", isHidden: true }],
    });

    const warning = report.warnings.find((w) => w.includes("без единого host'а"));
    assert.ok(warning, "адрес фронта у панели зашит в subgen — без предупреждения каскад соберётся в никуда");
    assert.ok(warning!.includes("RU2_FRONT"));
    assert.equal(warning!.includes("RU2_RELAY_IN"), false, "у relay-инбаунда host есть — жаловаться не на что");

    // скрытый в панели host у нас заводится видимым: там флаг значит «ссылку собирает
    // subgen», а у нас — «канала нет в подписке»
    assert.equal((await rows.hosts())[0].isHidden, false);
    assert.ok(report.warnings.some((w) => w.includes("скрыто host'ов: 1")));
  });

  it("нода с доменным адресом пропускается: сервер завести не из чего", async () => {
    const report = await runImport({
      profiles: [
        {
          name: "de-direct-reality",
          inbounds: [{ tag: "VLESS_REALITY_DE" }],
          nodes: [{ name: "de-asd", address: "de.example.com", cc: "DE" }],
        },
      ],
    });

    assert.deepEqual(await counts(), { servers: 0, profiles: 0, nodes: 0, inbounds: 0, hosts: 0 });
    assert.deepEqual(report.nodes, { total: 1, created: 0, updated: 0, skipped: 1 });
    assert.ok(report.warnings.some((w) => w.includes("de.example.com") && w.includes("не IP")));
  });
});

describe("InfraImportService: повторный прогон", () => {
  it("не двоит строки и не откатывает то, что завели после первого импорта", async () => {
    const first = await runImport(SHARED_PROFILE);
    const afterFirst = await counts();

    // между прогонами появляется то, чего в панели нет: доступ оператора, ссылка на
    // приватник от энроллмента агента, пометка front у host'а
    const [server] = await rows.servers();
    await db
      .update(schema.server)
      .set({ sshRef: "vault://projects/vpn/ssh/nl-hk-1", capabilities: { bandwidth: "1g" } })
      .where(eq(schema.server.id, server.id));
    const [profile] = await rows.profiles();
    await db
      .update(schema.configProfile)
      .set({ baseJson: { log: { loglevel: "warning" } } })
      .where(eq(schema.configProfile.id, profile.id));
    const [inbound] = await rows.inbounds();
    await db
      .update(schema.inbound)
      .set({ realityPrivkeyRef: "vault://projects/vpn/reality/nl1", params: { note: "оператор" } })
      .where(eq(schema.inbound.id, inbound.id));
    const [host] = await rows.hosts();
    await db.update(schema.host).set({ tagPrefix: "front" }).where(eq(schema.host.id, host.id));

    const second = await runImport(SHARED_PROFILE);

    assert.deepEqual(await counts(), afterFirst, "повторный импорт не имеет права ничего двоить");
    assert.deepEqual(first.nodes, { total: 2, created: 2, updated: 0, skipped: 0 });
    assert.deepEqual(second.nodes, { total: 2, created: 0, updated: 2, skipped: 0 });
    assert.deepEqual(second.inbounds, { total: 2, created: 0, updated: 2, skipped: 0 });
    assert.deepEqual(second.hosts, { total: 2, created: 0, updated: 2, skipped: 0 });

    const [serverAfter] = await db.select().from(schema.server).where(eq(schema.server.id, server.id));
    assert.equal(serverAfter.sshRef, "vault://projects/vpn/ssh/nl-hk-1", "панель про ssh_ref не знает — и не трогает");
    assert.deepEqual(serverAfter.capabilities, { bandwidth: "1g" });
    const [profileAfter] = await db.select().from(schema.configProfile).where(eq(schema.configProfile.id, profile.id));
    assert.deepEqual(profileAfter.baseJson, { log: { loglevel: "warning" } });
    const [inboundAfter] = await db.select().from(schema.inbound).where(eq(schema.inbound.id, inbound.id));
    assert.equal(inboundAfter.realityPrivkeyRef, "vault://projects/vpn/reality/nl1");
    assert.deepEqual(inboundAfter.params, { note: "оператор" });
    const [hostAfter] = await db.select().from(schema.host).where(eq(schema.host.id, host.id));
    assert.equal(hostAfter.tagPrefix, "front", "потеря front-пометки — это каскад, собранный в никуда");
  });

  it("не откатывает статус ноды, взятой нашим агентом", async () => {
    await runImport(SHARED_PROFILE);
    const [node] = await rows.nodes();
    await db.update(schema.node).set({ status: "active" }).where(eq(schema.node.id, node.id));

    await runImport(SHARED_PROFILE);

    const [after] = await db.select().from(schema.node).where(eq(schema.node.id, node.id));
    assert.equal(after.status, "active", "статус ставит отчёт агента, импорт его не знает");
  });

  it("сбой на одной строке не мешает остальным, повторный прогон доводит до конца", async () => {
    const broken: PanelSpec = {
      ...SHARED_PROFILE,
      hosts: [
        { remark: "NL-1", address: "147.90.10.12", tag: "VLESS_REALITY_NL1", alpn: "h9" },
        { remark: "NL-2", address: "147.90.10.15", tag: "VLESS_REALITY_NL2" },
      ],
    };

    const first = await runImport(broken);
    assert.equal(first.hosts.skipped, 1);
    assert.equal((await rows.hosts()).length, 1, "кривой host не должен утаскивать за собой весь прогон");
    assert.equal((await rows.nodes()).length, 2);
    assert.ok(first.warnings.some((w) => w.includes("NL-1") && w.includes("alpn")));

    const second = await runImport(SHARED_PROFILE);
    assert.deepEqual(await counts(), { servers: 2, profiles: 2, nodes: 2, inbounds: 2, hosts: 2 });
    assert.equal(second.hosts.created, 1, "второй прогон доводит недостающее, а не переделывает всё");
  });
});

describe("InfraImportService: dry-run", () => {
  it("ничего не пишет и считает ровно то же, что сделает apply", async () => {
    const dry = await runImport(SHARED_PROFILE, true);
    assert.deepEqual(await counts(), { servers: 0, profiles: 0, nodes: 0, inbounds: 0, hosts: 0 });

    const applied = await runImport(SHARED_PROFILE);
    assert.deepEqual(dry.servers, applied.servers);
    assert.deepEqual(dry.configProfiles, applied.configProfiles);
    assert.deepEqual(dry.nodes, applied.nodes);
    assert.deepEqual(dry.inbounds, applied.inbounds);
    assert.deepEqual(dry.hosts, applied.hosts);

    // и на уже импортированной сети dry-run обязан показывать обновление, а не создание
    const repeat = await runImport(SHARED_PROFILE, true);
    assert.deepEqual(repeat.nodes, { total: 2, created: 0, updated: 2, skipped: 0 });
    assert.deepEqual(repeat.hosts, { total: 2, created: 0, updated: 2, skipped: 0 });
  });
});

describe("InfraImportService: чужой config-профиль", () => {
  it("не переименовывает ноду, которой профиль уже принадлежит", async () => {
    const [server] = await db
      .insert(schema.server)
      .values({ orgId: TEST_ORG_ID, hostname: "10.0.0.1", primaryIp: "10.0.0.1" })
      .returning();
    const [profile] = await db
      .insert(schema.configProfile)
      .values({ orgId: TEST_ORG_ID, name: "nl-hk-1" })
      .returning();
    const [mine] = await db
      .insert(schema.node)
      .values({
        orgId: TEST_ORG_ID,
        serverId: server.id,
        configProfileId: profile.id,
        name: "своя-нода",
        roles: ["exit"],
      })
      .returning();

    const report = await runImport(SHARED_PROFILE);

    const [after] = await db.select().from(schema.node).where(eq(schema.node.id, mine.id));
    assert.equal(after.name, "своя-нода", "импорт не имеет права забрать чужую ноду вместе с её id и трафиком");
    assert.equal(after.serverId, server.id);
    assert.equal(report.nodes.skipped, 1);
    assert.ok(
      report.warnings.some((w) => w.includes("nl-hk-1") && w.includes("своя-нода")),
      "конфликт имён обязан быть виден в отчёте — молча пропустить ноду нельзя",
    );

    // вторая нода панели при этом переносится: отказ точечный, а не «весь импорт лёг»
    const imported = await db
      .select()
      .from(schema.node)
      .where(and(eq(schema.node.orgId, TEST_ORG_ID), eq(schema.node.name, "nl-hk-2")));
    assert.equal(imported.length, 1);
  });
});

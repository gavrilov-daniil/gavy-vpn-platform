/**
 * Мерчант с нечитаемыми кредами не должен ронять список.
 *
 * Сценарий штатный и описан в `.env.example`: сменили `SECRETS_MASTER_KEY` или подняли
 * дамп со старым ключом. До фикса `isConfigured` бросал наружу, и экран мерчантов
 * отвечал 500 ровно тогда, когда через него нужно заново ввести ключи, а бот
 * перестал бы получать ЛЮБОЙ способ оплаты, хотя остальные мерчанты исправны.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { schema, type Database } from "@corelink/db";
import { cleanupOrg, closeDb, createMerchant, openDb } from "../testing/fixtures.test.js";
import { MerchantService } from "./merchant.service.js";

let db: Database;
let merchants: MerchantService;
let brokenAlias: string;
let healthyAlias: string;

before(async () => {
  db = openDb();
  merchants = new MerchantService(db);

  const healthy = await createMerchant(db);
  healthyAlias = healthy.alias;

  // Строка, зашифрованная ДРУГИМ ключом: ровно то, что остаётся в БД после ротации
  const broken = await createMerchant(db, { credentials: { shop_id: "0f0f0f:0f0f0f:0f0f0f" } });
  brokenAlias = broken.alias;
});

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

describe("MerchantService: нечитаемые креды", () => {
  it("список отдаётся целиком, сломанный помечен ненастроенным", async () => {
    const rows = await merchants.listForAdmin();

    const healthy = rows.find((m) => m.alias === healthyAlias);
    const broken = rows.find((m) => m.alias === brokenAlias);

    assert.ok(healthy, "исправный мерчант обязан остаться в списке");
    assert.ok(broken, "сломанный обязан быть ВИДЕН — иначе его нечем починить из админки");
    assert.equal(healthy.isConfigured, true);
    assert.equal(broken.isConfigured, false, "нечитаемые креды — это «не настроен», а не сбой запроса");
  });

  it("доступные способы оплаты не пропадают из-за одного сломанного мерчанта", async () => {
    const available = await merchants.listAvailable("plan");

    assert.ok(
      available.some((m) => m.alias === healthyAlias),
      "исправный мерчант обязан остаться доступным боту",
    );
    assert.equal(
      available.some((m) => m.alias === brokenAlias),
      false,
      "сломанный не должен предлагаться клиенту: счёт по нему всё равно не создать",
    );
  });

  it("наружу креды не отдаются ни у исправного, ни у сломанного", async () => {
    const rows = await merchants.listForAdmin();

    for (const m of rows) {
      for (const value of Object.values(m.credentials)) {
        assert.equal(value, "••••••••", `значение кредов ${m.alias} утекло в ответ`);
      }
    }
  });
});

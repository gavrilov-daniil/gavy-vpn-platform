/**
 * Подпись Telegram Login Widget и вложенность ролей — чистые функции, без БД.
 *
 * Подпись здесь не «проверка на всякий случай», а единственное, что отделяет вход
 * оператора от произвольного POST с чужим telegram_id: подделав её, любой становится
 * кем угодно из уже подтверждённых.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { telegramWidgetPayload } from "../testing/fixtures.test.js";
import { verifyWidgetHash, type TelegramLoginPayload } from "./telegram-auth.service.js";
import { roleAtLeast } from "./roles.js";

const BOT_TOKEN = "123456:AAH-fake-bot-token-for-tests";

const sign = (fields: Omit<TelegramLoginPayload, "hash">, botToken = BOT_TOKEN): TelegramLoginPayload =>
  telegramWidgetPayload(fields as Record<string, string | number>, botToken) as unknown as TelegramLoginPayload;

const BASE = { id: 42, auth_date: 1_700_000_000, first_name: "Иван", username: "ivan" };

describe("подпись Telegram Login Widget", () => {
  it("подписанная виджетом полезная нагрузка принимается", () => {
    assert.equal(verifyWidgetHash(sign(BASE), BOT_TOKEN), true);
  });

  it("подменённый telegram_id не проходит: иначе вход подделывается за один POST", () => {
    const forged = { ...sign(BASE), id: 43 };
    assert.equal(verifyWidgetHash(forged, BOT_TOKEN), false);
  });

  it("подпись чужим ботом не проходит", () => {
    assert.equal(verifyWidgetHash(sign(BASE, "999:other-bot"), BOT_TOKEN), false);
  });

  it("мусор вместо hash не роняет проверку", () => {
    assert.equal(verifyWidgetHash({ ...BASE, hash: "не hex" }, BOT_TOKEN), false);
    assert.equal(verifyWidgetHash({ ...BASE, hash: "" }, BOT_TOKEN), false);
    // короткий hex — timingSafeEqual бросил бы на разной длине
    assert.equal(verifyWidgetHash({ ...BASE, hash: "abcdef" }, BOT_TOKEN), false);
  });

  it("добавленное поле ломает подпись: строка проверки считается по всем полям", () => {
    const withExtra = { ...sign(BASE), photo_url: "https://example.org/a.jpg" };
    assert.equal(verifyWidgetHash(withExtra, BOT_TOKEN), false);
  });
});

describe("вложенность ролей", () => {
  it("каждая роль умеет всё, что нижняя", () => {
    assert.equal(roleAtLeast("superadmin", "admin"), true);
    assert.equal(roleAtLeast("superadmin", "support"), true);
    assert.equal(roleAtLeast("admin", "support"), true);
    assert.equal(roleAtLeast("support", "support"), true);
  });

  it("вверх не пускает", () => {
    assert.equal(roleAtLeast("admin", "superadmin"), false);
    assert.equal(roleAtLeast("support", "admin"), false);
  });

  it("неизвестная роль не даёт ничего: fail-closed на мусоре в БД", () => {
    assert.equal(roleAtLeast("operator", "support"), false);
    assert.equal(roleAtLeast("", "support"), false);
  });
});

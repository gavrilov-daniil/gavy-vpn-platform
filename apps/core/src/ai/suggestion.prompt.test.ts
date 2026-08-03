/**
 * Что уезжает в чужую модель.
 *
 * В промпт идёт переписка клиента — персональные данные. Утечка отсюда необратима:
 * отозвать то, что уже ушло стороннему провайдеру, нельзя.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSuggestionPrompt, redactSecrets } from "./suggestion.prompt.js";

const VLESS_UUID = "6f1c4e9a-2b3d-4c5e-8a7b-9d0e1f2a3b4c";
const SHORT_UUID = "a1b2c3d4e5f60718293a4b5c";
const REALITY_PBK = "Xj2kL9mNpQrStUvWxYz012345678AbCdEfGhIjKlMnO";

describe("redactSecrets", () => {
  it("вырезает vless-ссылку целиком — внутри и uuid, и ключ Reality", () => {
    const text = `не работает vless://${VLESS_UUID}@1.2.3.4:443?pbk=${REALITY_PBK}&sid=aa01#DE`;
    const out = redactSecrets(text);
    assert.ok(!out.includes(VLESS_UUID), "uuid остался в тексте");
    assert.ok(!out.includes(REALITY_PBK), "ключ Reality остался в тексте");
    assert.ok(out.includes("не работает"), "вырезан осмысленный текст");
  });

  it("вырезает ссылку подписки и short_uuid, даже переданные по отдельности", () => {
    const text = `моя ссылка https://panel.gavy.shop/auto/${SHORT_UUID} и код ${SHORT_UUID}`;
    assert.ok(!redactSecrets(text, [SHORT_UUID]).includes(SHORT_UUID));
    // без списка секретов ссылку с длинным токеном ловит общий шаблон
    assert.ok(!redactSecrets(text).includes(SHORT_UUID));
  });

  it("вырезает точные секреты подписки, даже когда шаблон их не узнаёт", () => {
    // укороченный псевдо-uuid: под общий шаблон не подходит, но это реальный секрет
    const secret = "sub-key-7f3a91cc";
    const out = redactSecrets(`ключ ${secret} не подходит`, [secret]);
    assert.ok(!out.includes(secret));
  });

  it("вырезает значения полей, которые по имени являются секретом", () => {
    const out = redactSecrets('прислали {"api_key": "sk-live-abcdef123456", "password": "hunter2"}');
    assert.ok(!out.includes("sk-live-abcdef123456"));
    assert.ok(!out.includes("hunter2"));
  });

  it("не трогает обычный текст и ссылки без токенов", () => {
    const text = "Не открывается https://youtube.com с 14:30, оплатил 299 руб.";
    assert.equal(redactSecrets(text), text);
  });
});

describe("buildSuggestionPrompt", () => {
  const messages = [
    { senderType: "contact", content: "Здравствуйте, не подключается Германия" },
    { senderType: "operator", content: "Проверьте, пожалуйста, срок подписки" },
    { senderType: "contact", content: `моя ссылка vless://${VLESS_UUID}@1.2.3.4:443?pbk=${REALITY_PBK}` },
  ];

  it("не пропускает секреты подписки в готовый промпт", () => {
    const { prompt } = buildSuggestionPrompt({
      messages,
      documents: [{ id: "d1", title: "Подключение", body: `Ссылка вида https://host/auto/${SHORT_UUID}` }],
      maxContextChars: 4000,
      secrets: [VLESS_UUID, SHORT_UUID],
    });

    for (const secret of [VLESS_UUID, SHORT_UUID, REALITY_PBK]) {
      assert.ok(!prompt.includes(secret), `секрет ${secret.slice(0, 8)}… уехал в промпт`);
    }
    assert.ok(prompt.includes("не подключается Германия"), "полезный контекст потерян");
  });

  it("возвращает id только тех документов, что реально вошли в промпт", () => {
    const documents = [
      { id: "d1", title: "Первый", body: "а".repeat(5000) },
      { id: "d2", title: "Второй", body: "б".repeat(5000) },
    ];
    const { prompt, documentIds } = buildSuggestionPrompt({
      messages,
      documents,
      maxContextChars: 2000,
      secrets: [],
    });

    assert.deepEqual(documentIds, ["d1"], "во второй документ бюджета не осталось");
    assert.ok(!prompt.includes("Второй"));
  });

  it("держится лимита контекста и всё равно оставляет последнее сообщение клиента", () => {
    const long = Array.from({ length: 50 }, (_, i) => ({
      senderType: "contact" as const,
      content: `сообщение номер ${i} ${"ц".repeat(300)}`,
    }));
    const { prompt } = buildSuggestionPrompt({
      messages: long,
      documents: [],
      maxContextChars: 1500,
      secrets: [],
    });

    assert.ok(prompt.length < 2500, `промпт разросся до ${prompt.length} символов`);
    assert.ok(prompt.includes("сообщение номер 49"), "последнее сообщение клиента выброшено");
  });
});

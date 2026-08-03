/**
 * Подсказки операторам: идемпотентность, лимиты расхода и поведение при лежащем провайдере.
 *
 * Провайдер поднимается локальным HTTP-сервером — так проверяется вся цепочка целиком,
 * включая то, ЧТО именно уходит наружу: тело запроса читается из перехваченных вызовов,
 * а не подменяется моком сервиса.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import { encryptCredentials } from "@corelink/core-kit";
import { MASTER_KEY, TEST_ORG_ID, cleanupOrg, closeDb, createSubscriber, createSubscription, openDb } from "../testing/fixtures.test.js";
import { AiProviderService } from "./ai-provider.service.js";
import { KbService } from "./kb.service.js";
import { SuggestionService } from "./suggestion.service.js";

let db: Database;
let providers: AiProviderService;
let kb: KbService;
let suggestions: SuggestionService;

let server: Server;
let baseUrl: string;
/** Тела запросов к «провайдеру» — по ним проверяется, что ушло наружу. */
let received: Array<{ messages?: Array<{ role: string; content: string }> }> = [];
let providerDown = false;

before(async () => {
  db = openDb();
  providers = new AiProviderService(db);
  kb = new KbService(db);
  suggestions = new SuggestionService(db, providers, kb);

  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      received.push(JSON.parse(raw || "{}"));
      if (providerDown) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end('{"error":{"message":"провайдер недоступен"}}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "mock-1", choices: [{ message: { content: "Черновик ответа клиенту." } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

beforeEach(async () => {
  received = [];
  providerDown = false;
  await cleanupSupport();
});

after(async () => {
  await cleanupSupport();
  await closeDb(db);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Порядок от детей к родителям: FK без ON DELETE CASCADE. */
async function cleanupSupport() {
  const org = TEST_ORG_ID;
  await db.execute(sql`delete from ai_suggestion where org_id = ${org}`);
  await db.execute(sql`delete from message where org_id = ${org}`);
  await db.execute(sql`delete from conversation where org_id = ${org}`);
  await db.execute(sql`delete from support_contact where org_id = ${org}`);
  await db.execute(sql`delete from kb_document where org_id = ${org}`);
  await db.execute(sql`delete from ai_provider where org_id = ${org}`);
  await db.execute(sql`delete from job_dedup where org_id = ${org}`);
  await cleanupOrg(db);
}

async function enableProvider(settings: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(schema.aiProvider)
    .values({
      orgId: TEST_ORG_ID,
      provider: "openai_compatible",
      alias: `ai-${randomUUID().slice(0, 8)}`,
      isEnabled: true,
      model: "mock-1",
      credentials: encryptCredentials({ api_key: "test-key" }, MASTER_KEY),
      settings: { api_url: baseUrl, ...settings },
    })
    .returning();
  return row;
}

async function seedConversation(text: string, subscriberId?: string) {
  const [contact] = await db
    .insert(schema.supportContact)
    .values({
      orgId: TEST_ORG_ID,
      telegramUserId: Math.floor(Math.random() * 2 ** 40),
      subscriberId,
    })
    .returning();
  const [conversation] = await db
    .insert(schema.conversation)
    .values({ orgId: TEST_ORG_ID, contactId: contact.id, lastMessageAt: new Date() })
    .returning();
  const message = await addClientMessage(conversation.id, text);
  return { conversation, message, contact };
}

async function addClientMessage(conversationId: string, content: string) {
  const [row] = await db
    .insert(schema.message)
    .values({
      orgId: TEST_ORG_ID,
      conversationId,
      senderType: "contact",
      direction: "in",
      content,
      deliveryStatus: "sent",
      createdAt: new Date(),
    })
    .returning();
  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date() })
    .where(eq(schema.conversation.id, conversationId));
  return row;
}

async function suggestionsOf(conversationId: string) {
  return db
    .select()
    .from(schema.aiSuggestion)
    .where(
      and(eq(schema.aiSuggestion.orgId, TEST_ORG_ID), eq(schema.aiSuggestion.conversationId, conversationId)),
    );
}

function lastPrompt(): string {
  const body = received.at(-1);
  return body?.messages?.map((m) => m.content).join("\n") ?? "";
}

describe("SuggestionService.generate", () => {
  it("создаёт подсказку и показывает, на каких документах она основана", async () => {
    await enableProvider();
    const doc = await kb.create({
      title: "Подключение Германии",
      body: "Если Германия не подключается, обновите подписку в приложении и переподключитесь.",
    });
    await kb.create({ title: "Оплата картой", body: "Оплата картой проходит через СБП, зачисление мгновенное." });
    const { conversation } = await seedConversation("Не подключается Германия, что делать?");

    const result = await suggestions.generate({ conversationId: conversation.id });
    assert.equal(result.status, "created");

    const rows = await suggestionsOf(conversation.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "proposed");
    assert.equal(rows[0].content, "Черновик ответа клиенту.");
    assert.equal(rows[0].model, "mock-1");
    assert.deepEqual(rows[0].retrievedDocIds, [doc.id], "в подсказку попал не тот документ");
    assert.ok(lastPrompt().includes("Если Германия не подключается"), "документ не уехал в промпт");
  });

  it("повторная генерация на то же сообщение не создаёт вторую подсказку", async () => {
    await enableProvider();
    const { conversation } = await seedConversation("Здравствуйте, есть вопрос по тарифу");

    const first = await suggestions.generate({ conversationId: conversation.id });
    const second = await suggestions.generate({ conversationId: conversation.id });
    // force — это «повтори после сбоя», а не «сделай ещё одну»
    const third = await suggestions.generate({ conversationId: conversation.id, force: true });

    assert.equal(first.status, "created");
    assert.equal(second.status, "exists");
    assert.equal(third.status, "exists");
    assert.equal((await suggestionsOf(conversation.id)).length, 1);
    assert.equal(received.length, 1, "модель вызвали повторно и заплатили дважды");
  });

  it("секреты подписки не уходят провайдеру", async () => {
    await enableProvider();
    const subscriber = await createSubscriber(db);
    const subscription = await createSubscription(db, subscriber.id);
    const { conversation } = await seedConversation(
      `не работает vless://${subscription.vlessUuid}@1.2.3.4:443?pbk=Xj2kL9mNpQrStUvWxYz012345678AbCdEfGhIjKlMnO, ссылка https://panel.gavy.shop/auto/${subscription.shortUuid}`,
      subscriber.id,
    );

    const result = await suggestions.generate({ conversationId: conversation.id });
    assert.equal(result.status, "created");

    const prompt = lastPrompt();
    assert.ok(prompt.length > 0, "запрос к провайдеру не перехвачен");
    assert.ok(!prompt.includes(subscription.vlessUuid), "vless_uuid уехал в модель");
    assert.ok(!prompt.includes(subscription.shortUuid), "short_uuid уехал в модель");
    assert.ok(!prompt.includes("Xj2kL9mNpQrStUvWxYz012345678AbCdEfGhIjKlMnO"), "ключ Reality уехал в модель");
    assert.ok(prompt.includes("не работает"), "вырезан весь текст обращения");
  });

  it("провайдер лежит: обращение цело, подсказки нет, повтором его не добиваем", async () => {
    await enableProvider();
    const { conversation, message } = await seedConversation("Не приходит оплата");
    providerDown = true;

    const failed = await suggestions.generate({ conversationId: conversation.id });
    assert.equal(failed.status, "failed");
    assert.equal((await suggestionsOf(conversation.id)).length, 0);

    const callsAfterFailure = received.length;
    const repeat = await suggestions.generate({ conversationId: conversation.id });
    assert.equal(repeat.status, "skipped", "повтор снова пошёл в лежащего провайдера");
    assert.equal(received.length, callsAfterFailure);

    // переписка на месте — приём обращения от провайдера не зависит
    const messages = await db
      .select()
      .from(schema.message)
      .where(eq(schema.message.conversationId, conversation.id));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, message.id);
  });

  it("держит потолок подсказок на диалог", async () => {
    await enableProvider({ max_per_conversation: 1 });
    const { conversation } = await seedConversation("Первый вопрос");

    assert.equal((await suggestions.generate({ conversationId: conversation.id })).status, "created");

    await addClientMessage(conversation.id, "И ещё один вопрос");
    const limited = await suggestions.generate({ conversationId: conversation.id });
    assert.equal(limited.status, "skipped");
    assert.match(limited.status === "skipped" ? limited.reason : "", /лимит подсказок на диалог/);
    assert.equal((await suggestionsOf(conversation.id)).length, 1);
  });

  it("держит суточный потолок на организацию", async () => {
    await enableProvider({ max_per_day: 1 });
    const first = await seedConversation("Вопрос от первого клиента");
    const second = await seedConversation("Вопрос от второго клиента");

    assert.equal((await suggestions.generate({ conversationId: first.conversation.id })).status, "created");
    const limited = await suggestions.generate({ conversationId: second.conversation.id });
    assert.equal(limited.status, "skipped");
    assert.match(limited.status === "skipped" ? limited.reason : "", /суточный лимит/);
  });

  it("без подключённого провайдера просто ничего не делает", async () => {
    const { conversation } = await seedConversation("Вопрос без ИИ");
    const result = await suggestions.generate({ conversationId: conversation.id });
    assert.equal(result.status, "skipped");
    assert.equal(received.length, 0);
  });

  it("выключенный провайдер не используется", async () => {
    const provider = await enableProvider();
    await providers.update(provider.id, { isEnabled: false });
    const { conversation } = await seedConversation("Вопрос при выключенном ИИ");

    const result = await suggestions.generate({ conversationId: conversation.id });
    assert.equal(result.status, "skipped");
    assert.equal(received.length, 0);
  });
});

describe("статусы подсказки", () => {
  it("принятая без правок — accepted, с правками — edited, отклонённая — rejected", async () => {
    await enableProvider();
    const a = await seedConversation("Первый диалог");
    const b = await seedConversation("Второй диалог");
    const c = await seedConversation("Третий диалог");

    const created = await Promise.all([
      suggestions.generate({ conversationId: a.conversation.id }),
      suggestions.generate({ conversationId: b.conversation.id }),
      suggestions.generate({ conversationId: c.conversation.id }),
    ]);
    const ids = created.map((r) => (r.status === "created" ? r.suggestionId : ""));
    assert.ok(ids.every(Boolean));

    assert.equal((await suggestions.accept(ids[0])).status, "accepted");
    assert.equal((await suggestions.accept(ids[1], "Свой текст оператора")).status, "edited");
    assert.equal((await suggestions.reject(ids[2])).status, "rejected");
    assert.equal((await suggestions.markSent(ids[0])).status, "sent");
  });
});

describe("KbService.search", () => {
  it("находит документ по смыслу запроса и не отдаёт выключенные", async () => {
    const active = await kb.create({ title: "Возврат средств", body: "Возврат оформляется в течение 3 дней." });
    const disabled = await kb.create({ title: "Старая инструкция", body: "Возврат оформляется через почту." });
    await kb.update(disabled.id, { isActive: false });

    const hits = await kb.search("как оформить возврат средств");
    assert.deepEqual(
      hits.map((h) => h.id),
      [active.id],
    );
  });
});

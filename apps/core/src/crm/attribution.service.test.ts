/**
 * Атрибуция трафика. Ошибка здесь не видна глазом: она просто врёт в отчёте
 * по рекламе, и деньги уходят в канал, который на самом деле не окупается.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import {
  cleanupOrg,
  closeDb,
  createCampaignLink,
  createPayment,
  createSubscriber,
  openDb,
} from "../testing/fixtures.test.js";
import { AttributionService } from "./attribution.service.js";

let db: Database;
let attribution: AttributionService;

before(() => {
  db = openDb();
  attribution = new AttributionService(db);
});

beforeEach(() => cleanupOrg(db));

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

async function reloadLink(id: string) {
  const [row] = await db.select().from(schema.campaignLink).where(eq(schema.campaignLink.id, id));
  return row;
}

async function reloadSubscriber(id: string) {
  const [row] = await db.select().from(schema.subscriber).where(eq(schema.subscriber.id, id));
  return row;
}

async function eventsOf(campaignLinkId: string, type: string) {
  return db
    .select()
    .from(schema.campaignEvent)
    .where(and(eq(schema.campaignEvent.campaignLinkId, campaignLinkId), eq(schema.campaignEvent.type, type)));
}

describe("AttributionService: регистрация", () => {
  it("первый приход по ссылке фиксирует источник и крутит счётчик", async () => {
    const subscriber = await createSubscriber(db);
    const link = await createCampaignLink(db);

    const res = await attribution.onRegistration(subscriber.id, link.id);

    assert.equal(res.counted, true);
    assert.equal(res.firstTouch, true);
    assert.equal((await reloadSubscriber(subscriber.id)).campaignLinkId, link.id);
    assert.equal((await reloadLink(link.id)).registrations, 1);
    assert.equal((await eventsOf(link.id, "registration")).length, 1);
  });

  it("first-touch не перезаписывается: приход по другой ссылке даёт revisit и не меняет источник", async () => {
    const subscriber = await createSubscriber(db);
    const first = await createCampaignLink(db);
    const second = await createCampaignLink(db);

    await attribution.onRegistration(subscriber.id, first.id);
    const res = await attribution.onRegistration(subscriber.id, second.id);

    assert.equal(res.counted, false);
    assert.equal(res.firstTouch, false);
    assert.equal("reason" in res && res.reason, "revisit");
    assert.equal(
      (await reloadSubscriber(subscriber.id)).campaignLinkId,
      first.id,
      "источник клиента определяет первая ссылка, иначе последний канал приписывает себе чужие продажи",
    );
    assert.equal((await reloadLink(second.id)).registrations, 0, "revisit не имеет права крутить счётчик");
    assert.equal((await reloadLink(first.id)).registrations, 1);

    const [event] = await eventsOf(second.id, "registration");
    assert.deepEqual(event.meta, { revisit: true }, "повторный приход всё равно должен быть виден в логе");
  });

  it("регистрация засчитывается один раз на пару (подписчик, ссылка)", async () => {
    const subscriber = await createSubscriber(db);
    const link = await createCampaignLink(db);

    await attribution.onRegistration(subscriber.id, link.id);
    const repeat = await attribution.onRegistration(subscriber.id, link.id);

    assert.equal(repeat.counted, false);
    assert.equal("reason" in repeat && repeat.reason, "already_registered");
    assert.equal((await reloadLink(link.id)).registrations, 1, "переоткрытие той же ссылки не новый пользователь");
    assert.equal((await eventsOf(link.id, "registration")).length, 1);
  });

  it("разные подписчики по одной ссылке считаются каждый", async () => {
    const link = await createCampaignLink(db);
    const a = await createSubscriber(db);
    const b = await createSubscriber(db);

    await attribution.onRegistration(a.id, link.id);
    await attribution.onRegistration(b.id, link.id);

    assert.equal((await reloadLink(link.id)).registrations, 2);
  });

  it("невалидный, неизвестный и архивный код старта = органика, а не ошибка", async () => {
    const archived = await createCampaignLink(db, { isArchived: true });
    const live = await createCampaignLink(db);

    assert.equal(await attribution.resolveStartPayload(null), null);
    assert.equal(await attribution.resolveStartPayload("ref_123"), null, "чужой префикс — не наш код");
    assert.equal(await attribution.resolveStartPayload("c_0I1O"), null, "символы вне алфавита кода");
    assert.equal(await attribution.resolveStartPayload("c_ZZ"), null, "код короче четырёх символов");
    assert.equal(await attribution.resolveStartPayload(`c_${archived.code}`), null, "архивная ссылка не резолвится");
    assert.equal((await attribution.resolveStartPayload(`c_${live.code.toLowerCase()}`))?.id, live.id);
  });
});

describe("AttributionService: платёж", () => {
  /** Снимок источника в платёж ставит триггер БД — подписчик должен быть привязан ДО вставки. */
  async function paidPaymentFrom(link: { id: string }, patch: Partial<typeof schema.payment.$inferInsert> = {}) {
    const subscriber = await createSubscriber(db);
    await attribution.onRegistration(subscriber.id, link.id);
    const payment = await createPayment(db, {
      subscriberId: subscriber.id,
      amountKopeks: 50_000,
      status: "paid",
      isFirstPaid: true,
      ...patch,
    });
    return { subscriber, payment };
  }

  it("платёж атрибутируется один раз: повтор не задваивает выручку", async () => {
    const link = await createCampaignLink(db);
    const { payment } = await paidPaymentFrom(link);

    const first = await attribution.onPaymentPaid(payment.id);
    const second = await attribution.onPaymentPaid(payment.id);
    const after = await reloadLink(link.id);

    assert.equal(first.counted, true);
    assert.equal(second.counted, false);
    assert.equal("reason" in second && second.reason, "already_counted");
    assert.equal(after.revenueKopeks, 50_000, "повторный вызов не имеет права добавить выручку ещё раз");
    assert.equal(after.payingUsers, 1);
    assert.equal((await eventsOf(link.id, "payment")).length, 1);
  });

  it("второй платёж того же клиента добавляет выручку, но не нового плательщика", async () => {
    const link = await createCampaignLink(db);
    const { subscriber, payment } = await paidPaymentFrom(link);
    await attribution.onPaymentPaid(payment.id);

    const repeat = await createPayment(db, {
      subscriberId: subscriber.id,
      amountKopeks: 30_000,
      status: "paid",
      isFirstPaid: false,
    });
    await attribution.onPaymentPaid(repeat.id);
    const after = await reloadLink(link.id);

    assert.equal(after.revenueKopeks, 80_000);
    assert.equal(after.payingUsers, 1, "paying_users — уникальные плательщики, а не количество оплат");
  });

  it("органический платёж в счётчики кампании не попадает", async () => {
    const link = await createCampaignLink(db);
    const subscriber = await createSubscriber(db);
    const payment = await createPayment(db, { subscriberId: subscriber.id, amountKopeks: 50_000, status: "paid" });

    const res = await attribution.onPaymentPaid(payment.id);
    const after = await reloadLink(link.id);

    assert.equal(res.counted, false);
    assert.equal("reason" in res && res.reason, "organic");
    assert.equal(after.revenueKopeks, 0);
  });

  it("неоплаченный платёж не атрибутируется", async () => {
    const link = await createCampaignLink(db);
    const { payment } = await paidPaymentFrom(link, { status: "pending" });

    const res = await attribution.onPaymentPaid(payment.id);

    assert.equal(res.counted, false);
    assert.equal("reason" in res && res.reason, "not_paid");
    assert.equal((await reloadLink(link.id)).revenueKopeks, 0);
  });
});

/**
 * Деньги: путь вебхука провайдера от подписи до выданных дней.
 *
 * Проверяется наблюдаемый результат — что осталось в БД после вебхука,
 * а не то, какие методы кто вызвал.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import {
  cleanupOrg,
  closeDb,
  createMerchant,
  createPayment,
  createPlan,
  createSubscriber,
  createSubscription,
  openDb,
  paritypayWebhook,
} from "../testing/fixtures.test.js";
import { AttributionService } from "../crm/attribution.service.js";
import { LedgerService } from "./ledger.service.js";
import { MerchantService } from "./merchant.service.js";
import { PaymentService } from "./payment.service.js";

let db: Database;
let payments: PaymentService;

before(() => {
  db = openDb();
  payments = new PaymentService(db, new MerchantService(db), new LedgerService(db), new AttributionService(db));
});

beforeEach(() => cleanupOrg(db));

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

const DAY_MS = 86_400_000;

/** Подписчик с активной подпиской и выставленным счётом на тариф 500 ₽ / 30 дней. */
async function pendingPlanPayment(patch: Partial<typeof schema.payment.$inferInsert> = {}) {
  await createMerchant(db);
  const subscriber = await createSubscriber(db);
  const subscription = await createSubscription(db, subscriber.id, {
    expireAt: new Date(Date.now() + 10 * DAY_MS),
  });
  const plan = await createPlan(db, { periodDays: 30, priceKopeks: 50_000 });
  const payment = await createPayment(db, {
    subscriberId: subscriber.id,
    purpose: "plan",
    planId: plan.id,
    amountKopeks: 50_000,
    ...patch,
  });
  return { subscriber, subscription, plan, payment };
}

async function reloadPayment(id: string) {
  const [row] = await db.select().from(schema.payment).where(eq(schema.payment.id, id));
  return row;
}

async function reloadSubscription(id: string) {
  const [row] = await db.select().from(schema.subscription).where(eq(schema.subscription.id, id));
  return row;
}

async function activationsOf(subscriptionId: string) {
  return db
    .select()
    .from(schema.subscriptionActivation)
    .where(eq(schema.subscriptionActivation.subscriptionId, subscriptionId));
}

async function ledgerOf(subscriberId: string) {
  return db.select().from(schema.ledgerEntry).where(eq(schema.ledgerEntry.subscriberId, subscriberId));
}

describe("PaymentService: вебхук провайдера", () => {
  it("повторный вебхук не начисляет лишние дни и не двоит ledger", async () => {
    const { subscriber, subscription, payment } = await pendingPlanPayment();
    const hook = paritypayWebhook({ orderId: payment.providerPaymentId, status: "PAID", amountRub: 500 });

    const first = await payments.handleWebhook("paritypay", hook);
    const afterFirst = await reloadSubscription(subscription.id);

    const second = await payments.handleWebhook("paritypay", hook);
    const afterSecond = await reloadSubscription(subscription.id);

    assert.equal(first.ok, true);
    assert.equal("alreadyProcessed" in first && first.alreadyProcessed, false);
    assert.equal("alreadyProcessed" in second && second.alreadyProcessed, true, "второй вебхук обязан быть отбит");
    assert.equal(
      afterSecond.expireAt?.getTime(),
      afterFirst.expireAt?.getTime(),
      "ретрай провайдера не имеет права продлевать подписку ещё раз",
    );
    assert.equal((await activationsOf(subscription.id)).length, 1);
    assert.equal((await ledgerOf(subscriber.id)).length, 2, "topup + purchase, ровно по одному");
  });

  it("недоплата не фулфилится: платёж уходит в processing, дней и записей в ledger нет", async () => {
    const { subscriber, subscription, payment } = await pendingPlanPayment();

    const res = await payments.handleWebhook(
      "paritypay",
      paritypayWebhook({ orderId: payment.providerPaymentId, status: "PAID", amountRub: 100 }),
    );
    const after = await reloadPayment(payment.id);

    assert.equal(res.ok, false);
    assert.equal("reason" in res && res.reason, "amount_mismatch");
    assert.equal(after.status, "processing", "недоплата — ручной разбор, а не отказ и не зачисление");
    assert.equal(after.paidAt, null);
    assert.equal((await activationsOf(subscription.id)).length, 0);
    assert.equal((await ledgerOf(subscriber.id)).length, 0);
  });

  it("переплата принимается: деньги пришли, доступ выдаётся", async () => {
    const { subscription, payment } = await pendingPlanPayment();

    const res = await payments.handleWebhook(
      "paritypay",
      paritypayWebhook({ orderId: payment.providerPaymentId, status: "PAID", amountRub: 700 }),
    );
    const after = await reloadPayment(payment.id);

    assert.equal(res.ok, true);
    assert.equal(after.status, "paid");
    assert.equal((await activationsOf(subscription.id)).length, 1);
  });

  it("платёж в статусе failed всё ещё может стать paid: деньги уже у мерчанта", async () => {
    const { subscriber, subscription, payment } = await pendingPlanPayment({ status: "failed" });

    const res = await payments.handleWebhook(
      "paritypay",
      paritypayWebhook({ orderId: payment.providerPaymentId, status: "PAID", amountRub: 500 }),
    );
    const after = await reloadPayment(payment.id);

    assert.equal(res.ok, true);
    assert.equal(after.status, "paid");
    assert.ok(after.paidAt);
    assert.equal((await activationsOf(subscription.id)).length, 1, "не зачислить оплату = забрать деньги без услуги");
    assert.equal((await ledgerOf(subscriber.id)).length, 2);
  });

  it("истёкший по нашему TTL платёж тоже зачисляется", async () => {
    const { subscription, payment } = await pendingPlanPayment({ status: "expired" });

    await payments.handleWebhook(
      "paritypay",
      paritypayWebhook({ orderId: payment.providerPaymentId, status: "PAID", amountRub: 500 }),
    );

    assert.equal((await reloadPayment(payment.id)).status, "paid");
    assert.equal((await activationsOf(subscription.id)).length, 1);
  });

  it("вебхук с испорченной подписью не меняет в БД ничего", async () => {
    const { subscriber, subscription, payment } = await pendingPlanPayment();

    const res = await payments.handleWebhook(
      "paritypay",
      paritypayWebhook({ orderId: payment.providerPaymentId, status: "PAID", amountRub: 500, breakSignature: true }),
    );
    const after = await reloadPayment(payment.id);

    assert.equal(res.ok, false);
    assert.equal("reason" in res && res.reason, "invalid_signature");
    assert.equal(after.status, "pending");
    assert.equal((await activationsOf(subscription.id)).length, 0);
    assert.equal((await ledgerOf(subscriber.id)).length, 0);
  });

  it("неоплаченный статус переводит платёж, но денег не начисляет", async () => {
    const { subscriber, subscription, payment } = await pendingPlanPayment();

    const res = await payments.handleWebhook(
      "paritypay",
      paritypayWebhook({ orderId: payment.providerPaymentId, status: "EXPIRED", amountRub: 500 }),
    );
    const after = await reloadPayment(payment.id);

    assert.equal(res.ok, true);
    assert.equal(after.status, "expired");
    assert.equal((await activationsOf(subscription.id)).length, 0);
    assert.equal((await ledgerOf(subscriber.id)).length, 0);
  });

  it("вебхук на неизвестный order_id не создаёт платёж из воздуха", async () => {
    await createMerchant(db);

    const res = await payments.handleWebhook(
      "paritypay",
      paritypayWebhook({ orderId: "ord-не-существует", status: "PAID", amountRub: 500 }),
    );

    assert.equal(res.ok, false);
    assert.equal("reason" in res && res.reason, "payment_not_found");
  });

  it("второй платёж того же клиента доходит до выдачи дней (регресс первой оплаты)", async () => {
    const { subscriber, subscription, plan, payment } = await pendingPlanPayment();
    await payments.handleWebhook(
      "paritypay",
      paritypayWebhook({ orderId: payment.providerPaymentId, status: "PAID", amountRub: 500 }),
    );
    const afterFirst = await reloadSubscription(subscription.id);

    const second = await createPayment(db, {
      subscriberId: subscriber.id,
      purpose: "plan",
      planId: plan.id,
      amountKopeks: 50_000,
    });
    const res = await payments.handleWebhook(
      "paritypay",
      paritypayWebhook({ orderId: second.providerPaymentId, status: "PAID", amountRub: 500 }),
    );
    const afterSecond = await reloadSubscription(subscription.id);

    assert.equal(res.ok, true);
    assert.equal((await reloadPayment(second.id)).status, "paid");
    assert.equal(
      Math.round((afterSecond.expireAt!.getTime() - afterFirst.expireAt!.getTime()) / DAY_MS),
      30,
      "второй платёж обязан добавить свои дни, а не откатиться целиком",
    );
    assert.equal((await activationsOf(subscription.id)).length, 2);
    assert.equal((await ledgerOf(subscriber.id)).length, 4);
  });

  it("выключенный мерчант вебхуки не обслуживает", async () => {
    await createMerchant(db, { isEnabled: false });
    const subscriber = await createSubscriber(db);
    const payment = await createPayment(db, { subscriberId: subscriber.id });

    await assert.rejects(
      () =>
        payments.handleWebhook(
          "paritypay",
          paritypayWebhook({ orderId: payment.providerPaymentId, status: "PAID", amountRub: 500 }),
        ),
      /мерчант/i,
    );
    assert.equal((await reloadPayment(payment.id)).status, "pending");
  });
});

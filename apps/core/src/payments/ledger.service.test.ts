/**
 * Деньги: фулфилмент оплаченного платежа.
 *
 * Каждый дефект, закрытый здесь, стоил бы реальных денег — либо лишними днями
 * доступа за один платёж, либо принятой оплатой без выдачи услуги.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import {
  TEST_ORG_ID,
  cleanupOrg,
  closeDb,
  createPayment,
  createPlan,
  createSquad,
  createSubscriber,
  createSubscription,
  openDb,
} from "../testing/fixtures.test.js";
import { LedgerService } from "./ledger.service.js";

let db: Database;
let ledger: LedgerService;

before(() => {
  db = openDb();
  ledger = new LedgerService(db);
});

beforeEach(() => cleanupOrg(db));

after(async () => {
  await cleanupOrg(db);
  await closeDb(db);
});

const DAY_MS = 86_400_000;

/** Так же, как это делает PaymentService: фулфилмент идёт внутри транзакции платежа. */
function fulfill(payment: typeof schema.payment.$inferSelect) {
  return db.transaction((tx) => ledger.fulfillPayment(tx, payment));
}

async function fulfillPlan(payment: typeof schema.payment.$inferSelect) {
  const result = await fulfill(payment);
  if (result.kind !== "plan") throw new Error(`ожидался фулфилмент тарифа, получен ${result.kind}`);
  return result;
}

async function reload(subscriptionId: string) {
  const [row] = await db.select().from(schema.subscription).where(eq(schema.subscription.id, subscriptionId));
  return row;
}

async function ledgerOf(subscriberId: string) {
  return db
    .select()
    .from(schema.ledgerEntry)
    .where(and(eq(schema.ledgerEntry.orgId, TEST_ORG_ID), eq(schema.ledgerEntry.subscriberId, subscriberId)));
}

async function activationsOf(subscriptionId: string) {
  return db
    .select()
    .from(schema.subscriptionActivation)
    .where(eq(schema.subscriptionActivation.subscriptionId, subscriptionId));
}

describe("LedgerService: фулфилмент оплаты", () => {
  it("повторный фулфилмент того же платежа не начисляет дни второй раз и не двоит ledger", async () => {
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
      status: "paid",
    });

    await fulfillPlan(payment);
    const afterFirst = await reload(subscription.id);

    const second = await fulfillPlan(payment);
    const afterSecond = await reload(subscription.id);

    assert.equal(second.action, "already_applied", "вторая активация обязана быть отбита UNIQUE(payment_id)");
    assert.equal(
      afterSecond.expireAt?.getTime(),
      afterFirst.expireAt?.getTime(),
      "повторный вебхук не имеет права продлевать подписку ещё раз",
    );
    assert.equal((await activationsOf(subscription.id)).length, 1);
    assert.equal((await ledgerOf(subscriber.id)).length, 2, "ровно topup + purchase, без дублей");
  });

  it("второй платёж того же клиента проходит целиком (markFirstPaid не роняет транзакцию)", async () => {
    const subscriber = await createSubscriber(db);
    const subscription = await createSubscription(db, subscriber.id, {
      expireAt: new Date(Date.now() + 10 * DAY_MS),
    });
    const plan = await createPlan(db, { periodDays: 30, priceKopeks: 50_000 });

    const first = await createPayment(db, {
      subscriberId: subscriber.id,
      purpose: "plan",
      planId: plan.id,
      amountKopeks: 50_000,
      status: "paid",
    });
    await fulfillPlan(first);
    const afterFirst = await reload(subscription.id);

    const second = await createPayment(db, {
      subscriberId: subscriber.id,
      purpose: "plan",
      planId: plan.id,
      amountKopeks: 50_000,
      status: "paid",
    });
    const result = await fulfillPlan(second);
    const afterSecond = await reload(subscription.id);

    assert.equal(result.action, "extended");
    assert.equal(
      Math.round((afterSecond.expireAt!.getTime() - afterFirst.expireAt!.getTime()) / DAY_MS),
      30,
      "второй платёж обязан добавить свои 30 дней поверх первого",
    );
    assert.equal((await activationsOf(subscription.id)).length, 2);
    assert.equal((await ledgerOf(subscriber.id)).length, 4, "два платежа = два topup + два purchase");

    const flags = await db
      .select({ id: schema.payment.id, isFirstPaid: schema.payment.isFirstPaid })
      .from(schema.payment)
      .where(eq(schema.payment.subscriberId, subscriber.id));
    assert.equal(
      flags.filter((p) => p.isFirstPaid).length,
      1,
      "флаг первой оплаты живёт под partial unique — он ровно один на подписчика",
    );
    assert.equal(flags.find((p) => p.isFirstPaid)?.id, first.id);
  });

  it("покупка после истечения подписки начисляет дни: активация с action=created не глотается", async () => {
    const subscriber = await createSubscriber(db);
    const subscription = await createSubscription(db, subscriber.id, { expireAt: null, status: "expired" });
    const plan = await createPlan(db, { periodDays: 30, priceKopeks: 50_000 });

    const first = await createPayment(db, {
      subscriberId: subscriber.id,
      purpose: "plan",
      planId: plan.id,
      amountKopeks: 50_000,
      status: "paid",
    });
    assert.equal((await fulfillPlan(first)).action, "created");

    // срок вышел — следующая покупка снова пойдёт как «created»
    await db
      .update(schema.subscription)
      .set({ expireAt: new Date(Date.now() - 5 * DAY_MS), status: "expired" })
      .where(eq(schema.subscription.id, subscription.id));

    const second = await createPayment(db, {
      subscriberId: subscriber.id,
      purpose: "plan",
      planId: plan.id,
      amountKopeks: 50_000,
      status: "paid",
    });
    const secondResult = await fulfillPlan(second);
    const after = await reload(subscription.id);

    assert.equal(secondResult.action, "created", "истёкшая подписка возобновляется, а не «уже применена»");
    assert.equal(after.status, "active");
    assert.ok(
      after.expireAt!.getTime() > Date.now() + 29 * DAY_MS,
      "клиент заплатил после истечения — дни обязаны начислиться",
    );
    assert.equal((await activationsOf(subscription.id)).length, 2);
  });

  it("баланс считается как SUM(ledger), отдельного поля balance в схеме нет", async () => {
    const subscriber = await createSubscriber(db);
    await createSubscription(db, subscriber.id, { expireAt: new Date(Date.now() + 10 * DAY_MS) });
    const plan = await createPlan(db, { periodDays: 30, priceKopeks: 30_000 });

    const topup = await createPayment(db, {
      subscriberId: subscriber.id,
      purpose: "topup",
      amountKopeks: 100_000,
      status: "paid",
    });
    await fulfill(topup);
    assert.equal(await ledger.getBalance(subscriber.id), 100_000);

    const purchase = await createPayment(db, {
      subscriberId: subscriber.id,
      purpose: "plan",
      planId: plan.id,
      amountKopeks: 30_000,
      status: "paid",
    });
    await fulfillPlan(purchase);

    const entries = await ledgerOf(subscriber.id);
    const sum = entries.reduce((acc, e) => acc + e.amountKopeks, 0);
    assert.equal(await ledger.getBalance(subscriber.id), sum);
    assert.equal(sum, 100_000 + 30_000 - 30_000, "покупка тарифа = пополнение на сумму платежа минус цена тарифа");

    // Ledger-first держится только пока в схеме нет денормализованного баланса,
    // который кто-нибудь начнёт править напрямую.
    const stray = await db.execute(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and column_name in ('balance', 'balance_kopeks')
    `);
    assert.equal(
      Array.from(stray as unknown as unknown[]).length,
      0,
      "появилось поле balance — баланс обязан оставаться агрегатом по ledger",
    );
  });

  it("пополнение баланса не выдаёт дней: активации нет, срок не двигается", async () => {
    const subscriber = await createSubscriber(db);
    const expireAt = new Date(Date.now() + 10 * DAY_MS);
    const subscription = await createSubscription(db, subscriber.id, { expireAt });

    const payment = await createPayment(db, {
      subscriberId: subscriber.id,
      purpose: "topup",
      amountKopeks: 70_000,
      status: "paid",
    });
    const result = await fulfill(payment);
    const after = await reload(subscription.id);

    assert.equal(result.kind, "topup");
    assert.equal((await activationsOf(subscription.id)).length, 0);
    assert.equal(after.expireAt?.getTime(), expireAt.getTime());
    assert.equal(await ledger.getBalance(subscriber.id), 70_000);
  });

  it("оплата тарифа выдаёт доступ к squad'ам тарифа, а при смене тарифа лишние снимаются", async () => {
    const subscriber = await createSubscriber(db);
    const subscription = await createSubscription(db, subscriber.id, {
      expireAt: new Date(Date.now() + 10 * DAY_MS),
    });
    const squadA = await createSquad(db);
    const squadB = await createSquad(db);

    const basic = await createPlan(db, { squadIds: [squadA.id] });
    await fulfillPlan(
      await createPayment(db, {
        subscriberId: subscriber.id,
        purpose: "plan",
        planId: basic.id,
        amountKopeks: 50_000,
        status: "paid",
      }),
    );

    const granted = async () =>
      (
        await db
          .select({ squadId: schema.subscriptionSquad.squadId })
          .from(schema.subscriptionSquad)
          .where(eq(schema.subscriptionSquad.subscriptionId, subscription.id))
      )
        .map((r) => r.squadId)
        .sort();

    assert.deepEqual(await granted(), [squadA.id], "без членства в squad нода не пустит клиента, хотя подписка активна");

    const premium = await createPlan(db, { squadIds: [squadB.id] });
    await fulfillPlan(
      await createPayment(db, {
        subscriberId: subscriber.id,
        purpose: "plan",
        planId: premium.id,
        amountKopeks: 50_000,
        status: "paid",
      }),
    );

    assert.deepEqual(await granted(), [squadB.id], "доступ старого тарифа не должен накапливаться поверх нового");
  });

  it("оплата тарифа без подписки не теряет деньги: баланс пополнен, дней нет", async () => {
    const subscriber = await createSubscriber(db);
    const plan = await createPlan(db);
    const payment = await createPayment(db, {
      subscriberId: subscriber.id,
      purpose: "plan",
      planId: plan.id,
      amountKopeks: 50_000,
      status: "paid",
    });

    const result = await fulfillPlan(payment);

    assert.equal(result.action, "none", "подписки нет — продлевать нечего");
    assert.equal(await ledger.getBalance(subscriber.id), 50_000, "деньги приняты, значит они обязаны лежать на балансе");
  });
});

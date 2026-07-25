import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { getAdapter, SUPPORTED_PROVIDERS, PROVIDER_SPECS } from "./registry.js";
import { signParityPayParams } from "./adapters/paritypay.js";
import { signPal24Postback } from "./adapters/pal24.js";
import { verifyCryptoBotSignature, formatCryptoAmount } from "./adapters/cryptobot.js";
import { verifyOxaPaySignature } from "./adapters/oxapay.js";
import { buildStarsPayload, extractOrderIdFromStarsPayload, verifyStarsCharge } from "./adapters/stars.js";
import type { MerchantConfig } from "./types.js";

const merchant = (provider: string, credentials: Record<string, string>, settings: Record<string, unknown> = {}): MerchantConfig => ({
  id: "m1",
  provider: provider as MerchantConfig["provider"],
  alias: `${provider}-main`,
  mode: "test",
  credentials,
  settings,
});

test("реестр: все 5 провайдеров зарегистрированы и имеют спеку для админки", () => {
  assert.deepEqual([...SUPPORTED_PROVIDERS].sort(), ["cryptobot", "oxapay", "pal24", "paritypay", "stars"]);
  for (const p of SUPPORTED_PROVIDERS) {
    assert.equal(getAdapter(p).provider, p);
    assert.ok(PROVIDER_SPECS.find((s) => s.provider === p), `нет спеки для ${p}`);
  }
  assert.throws(() => getAdapter("yookassa"));
});

test("ParityPay: подпись = sorted keys + concat без разделителя + HMAC-SHA256", () => {
  const secret = "pp-secret";
  const params = { shop_id: "42", amount: 100, order_id: "abc" };
  // ожидание считаем независимо: сортировка ключей → amount, order_id, shop_id
  const expected = createHmac("sha256", secret).update("100abc42").digest("hex");
  assert.equal(signParityPayParams(params, secret), expected);
});

test("ParityPay: null/undefined поля не входят в подпись, порядок ключей не важен", () => {
  const secret = "pp-secret";
  const a = signParityPayParams({ b: "2", a: "1", skip: null, gone: undefined }, secret);
  const b = signParityPayParams({ a: "1", b: "2" }, secret);
  assert.equal(a, b);
});

test("ParityPay: verifyWebhook принимает валидную и отвергает подделанную подпись", () => {
  const adapter = getAdapter("paritypay");
  const m = merchant("paritypay", { shop_id: "1", api_key: "k", webhook_secret: "whsec" });
  const payload = { id: "inv-1", order_id: "ord-1", status: "PAID", amount: 500 };
  const rawBody = JSON.stringify(payload);
  const good = signParityPayParams(payload, "whsec");

  assert.equal(adapter.verifyWebhook(m, { rawBody, headers: { "x-signature": good } }), true);
  assert.equal(adapter.verifyWebhook(m, { rawBody, headers: { "x-signature": "deadbeef" } }), false);
  assert.equal(adapter.verifyWebhook(m, { rawBody, headers: {} }), false);
});

test("ParityPay: parseWebhook мапит статусы и ищет по order_id", () => {
  const adapter = getAdapter("paritypay");
  const m = merchant("paritypay", { shop_id: "1", api_key: "k", webhook_secret: "s" });
  const parse = (status: string) =>
    adapter.parseWebhook(m, { rawBody: JSON.stringify({ id: "inv-9", order_id: "ord-9", status, amount: 12.34 }), headers: {} });

  assert.equal(parse("PAID").status, "paid");
  assert.equal(parse("EXPIRED").status, "expired");
  assert.equal(parse("REFUNDED").status, "refunded");
  assert.equal(parse("NEW").status, "pending");
  const p = parse("PAID");
  assert.equal(p.providerPaymentId, "ord-9");
  assert.equal(p.providerRef, "inv-9");
  assert.equal(p.amountKopeks, 1234);
});

test("Pal24: подпись postback = UPPER(md5(OutSum:InvId:token))", () => {
  const expected = createHash("md5").update("100.00:inv-1:tok").digest("hex").toUpperCase();
  assert.equal(signPal24Postback("100.00", "inv-1", "tok"), expected);
});

test("Pal24: OutSum сверяется строкой — '100.00' и '100' дают разные подписи", () => {
  assert.notEqual(signPal24Postback("100.00", "i", "t"), signPal24Postback("100", "i", "t"));
});

test("Pal24: verifyWebhook по form-urlencoded телу", () => {
  const adapter = getAdapter("pal24");
  const m = merchant("pal24", { shop_id: "1", token: "tok" });
  const sig = signPal24Postback("250.00", "ord-5", "tok");
  const rawBody = new URLSearchParams({ InvId: "ord-5", OutSum: "250.00", Status: "SUCCESS", SignatureValue: sig }).toString();

  assert.equal(adapter.verifyWebhook(m, { rawBody, headers: {} }), true);
  const bad = new URLSearchParams({ InvId: "ord-5", OutSum: "250.00", Status: "SUCCESS", SignatureValue: "BAD" }).toString();
  assert.equal(adapter.verifyWebhook(m, { rawBody: bad, headers: {} }), false);
});

test("Pal24: UNDERPAID не считается оплатой (не фулфилим недоплату)", () => {
  const adapter = getAdapter("pal24");
  const m = merchant("pal24", { shop_id: "1", token: "t" });
  const parse = (status: string) =>
    adapter.parseWebhook(m, {
      rawBody: new URLSearchParams({ InvId: "o1", OutSum: "10.00", Status: status, TrsId: "bill-1" }).toString(),
      headers: {},
    });

  assert.equal(parse("SUCCESS").status, "paid");
  assert.equal(parse("OVERPAID").status, "paid");
  assert.equal(parse("UNDERPAID").status, "processing");
  assert.equal(parse("FAIL").status, "failed");
  assert.equal(parse("SUCCESS").providerPaymentId, "o1");
});

test("CryptoBot: подпись = HMAC-SHA256(sha256(token), rawBody)", () => {
  const token = "cb-token";
  const rawBody = JSON.stringify({ update_id: 1, payload: { invoice_id: 7, status: "paid" } });
  const secret = createHash("sha256").update(token).digest();
  const sig = createHmac("sha256", secret).update(rawBody).digest("hex");

  assert.equal(verifyCryptoBotSignature(token, rawBody, sig), true);
  assert.equal(verifyCryptoBotSignature(token, rawBody, sig.replace(/.$/, "0")), false);
  assert.equal(verifyCryptoBotSignature(token, rawBody, "short"), false, "разная длина не должна кидать");
  assert.equal(verifyCryptoBotSignature(token, `${rawBody} `, sig), false, "тело изменено — подпись невалидна");
});

test("CryptoBot: точность крипто-сумм (BTC/ETH 8 знаков, прочее 6)", () => {
  assert.equal(formatCryptoAmount(0.123456789, "BTC"), "0.12345679");
  assert.equal(formatCryptoAmount(0.123456789, "USDT"), "0.123457");
});

test("OxaPay: подпись = HMAC-SHA512(api_key, rawBody), заголовок hmac", () => {
  const key = "oxa-key";
  const rawBody = JSON.stringify({ track_id: "t1", status: "paid" });
  const sig = createHmac("sha512", key).update(rawBody).digest("hex");
  const adapter = getAdapter("oxapay");
  const m = merchant("oxapay", { merchant_api_key: key });

  assert.equal(verifyOxaPaySignature(key, rawBody, sig), true);
  assert.equal(adapter.verifyWebhook(m, { rawBody, headers: { hmac: sig } }), true);
  assert.equal(adapter.verifyWebhook(m, { rawBody, headers: { hmac: "bad" } }), false);
  assert.equal(adapter.verifyWebhook(m, { rawBody, headers: {} }), false);
});

test("OxaPay: статусы и крипто-детали из txs[0]", () => {
  const adapter = getAdapter("oxapay");
  const m = merchant("oxapay", { merchant_api_key: "k" });
  const parsed = adapter.parseWebhook(m, {
    rawBody: JSON.stringify({
      track_id: "tr-1",
      status: "paid",
      txs: [{ currency: "USDT", network: "TRC20", received_amount: "10.5", rate: "95.2" }],
    }),
    headers: {},
  });
  assert.equal(parsed.status, "paid");
  assert.equal(parsed.providerPaymentId, "tr-1");
  assert.equal(parsed.cryptoAsset, "USDT");
  assert.equal(parsed.cryptoNetwork, "TRC20");

  const waiting = adapter.parseWebhook(m, { rawBody: JSON.stringify({ track_id: "t", status: "confirming" }), headers: {} });
  assert.equal(waiting.status, "processing");
});

test("OxaPay честно объявляет, что умеет только пополнение баланса", () => {
  assert.deepEqual([...getAdapter("oxapay").supportedPurposes], ["topup"]);
});

test("Stars: payload round-trip и отказ на чужом формате", () => {
  assert.equal(extractOrderIdFromStarsPayload(buildStarsPayload("ord-1")), "ord-1");
  assert.equal(extractOrderIdFromStarsPayload("other:ord-1"), null);
  assert.equal(extractOrderIdFromStarsPayload("gavy-stars:"), null);
});

test("Stars: сумма сверяется — оплата 1 звездой не проходит за план в 500", () => {
  assert.deepEqual(verifyStarsCharge({ invoicePayload: buildStarsPayload("o1"), totalAmount: 500, expectedAmountStars: 500 }), {
    ok: true,
    orderId: "o1",
  });
  assert.deepEqual(verifyStarsCharge({ invoicePayload: buildStarsPayload("o1"), totalAmount: 1, expectedAmountStars: 500 }), {
    ok: false,
    reason: "amount_mismatch",
  });
  assert.deepEqual(verifyStarsCharge({ invoicePayload: "junk", totalAmount: 500, expectedAmountStars: 500 }), {
    ok: false,
    reason: "unknown_payload_format",
  });
});

test("Stars: createInvoice не ходит по HTTP, а делегирует счёт боту", async () => {
  const adapter = getAdapter("stars");
  const m = merchant("stars", {}, { stars_to_kopeks_rate: 100 });
  const invoice = await adapter.createInvoice(m, {
    orderId: "o7",
    amountKopeks: 50_000,
    purpose: "plan",
    description: "План",
    telegramUserId: 12345,
  });
  assert.equal(invoice.deferredToBot?.amountStars, 500);
  assert.equal(invoice.deferredToBot?.payload, "gavy-stars:o7");
  assert.equal(invoice.providerPaymentId, "o7");
});

test("isConfigured: мерчант без ключей не даёт создать счёт, но не роняет старт", async () => {
  const empty = merchant("paritypay", {});
  assert.equal(getAdapter("paritypay").isConfigured(empty), false);
  await assert.rejects(
    getAdapter("paritypay").createInvoice(empty, { orderId: "o", amountKopeks: 100, purpose: "topup", description: "d" }),
    /NOT_CONFIGURED|не задан ключ/,
  );
  assert.equal(getAdapter("pal24").isConfigured(merchant("pal24", { shop_id: "1", token: "t" })), true);
});

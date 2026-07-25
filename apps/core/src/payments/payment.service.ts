import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { schema, type Database } from "@vpn/db";
import { getAdapter, type PaymentPurpose, type WebhookRequest } from "@vpn/payments";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { MerchantService } from "./merchant.service.js";
import { LedgerService } from "./ledger.service.js";
import { AttributionService } from "../crm/attribution.service.js";

export interface CreatePaymentInput {
  subscriberId: string;
  merchantId: string;
  purpose: PaymentPurpose;
  amountKopeks?: number;
  planId?: string;
  asset?: string;
  method?: string;
  telegramUserId?: number;
}

/**
 * ЕДИНЫЙ платёжный flow на всех провайдеров.
 * В проде было 5 почти одинаковых flow-сервисов (~2500 строк copy-paste),
 * из-за чего статусы разошлись: у одного провайдера expired-платёж дозачислялся,
 * у другого — терялся вместе с деньгами. Здесь ветвление только в адаптере.
 */
@Injectable()
export class PaymentService {
  private readonly log = new Logger(PaymentService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly merchants: MerchantService,
    private readonly ledger: LedgerService,
    private readonly attribution: AttributionService,
  ) {}

  async createPayment(input: CreatePaymentInput) {
    const merchant = await this.merchants.getConfig(input.merchantId);
    const adapter = getAdapter(merchant.provider);

    if (!adapter.supportedPurposes.includes(input.purpose)) {
      throw new BadRequestException(`${merchant.provider} не поддерживает ${input.purpose}`);
    }
    if (!adapter.isConfigured(merchant)) {
      throw new BadRequestException(`${merchant.provider.toUpperCase()}_NOT_CONFIGURED`);
    }

    const { amountKopeks, plan } = await this.resolveAmount(input);
    const orderId = `${merchant.provider}-${input.purpose}-${randomBytes(8).toString("hex")}`;

    // Платёж создаётся ДО обращения к провайдеру: если провайдер ответит, а мы упадём,
    // вебхук всё равно найдёт запись по order_id.
    const [payment] = await this.db
      .insert(schema.payment)
      .values({
        orgId: this.cfg.defaultOrgId,
        subscriberId: input.subscriberId,
        merchantId: input.merchantId,
        provider: merchant.provider,
        providerPaymentId: orderId,
        purpose: input.purpose,
        planId: plan?.id,
        amountKopeks,
        status: "pending",
      })
      .returning();

    try {
      const invoice = await adapter.createInvoice(merchant, {
        orderId,
        amountKopeks,
        purpose: input.purpose,
        description: plan ? plan.title : "Пополнение баланса",
        asset: input.asset,
        method: input.method,
        telegramUserId: input.telegramUserId,
        callbackUrl: `${this.cfg.publicApiUrl}/webhooks/${merchant.provider}`,
        successUrl: this.cfg.paymentSuccessUrl || undefined,
        failUrl: this.cfg.paymentFailUrl || undefined,
      });

      await this.db
        .update(schema.payment)
        .set({
          providerPaymentId: invoice.providerPaymentId,
          providerRef: invoice.providerRef,
          expiresAt: invoice.expiresAt,
          cryptoAsset: invoice.cryptoAsset,
          cryptoAmount: invoice.cryptoAmount,
          exchangeRate: invoice.exchangeRate,
          meta: { invoice: invoice.raw ?? null },
        })
        .where(eq(schema.payment.id, payment.id));

      return { payment, invoice };
    } catch (err) {
      await this.db.update(schema.payment).set({ status: "failed" }).where(eq(schema.payment.id, payment.id));
      throw err;
    }
  }

  /**
   * Обработка вебхука. Порядок жёсткий:
   *   1. подпись (иначе 401 ДО всякой обработки),
   *   2. поиск платежа,
   *   3. атомарный claim статуса (compare-and-swap),
   *   4. фулфилмент в той же транзакции.
   * Вызывающий отвечает провайдеру 200 даже при внутренней ошибке — иначе он завалит ретраями.
   */
  async handleWebhook(provider: string, req: WebhookRequest) {
    const adapter = getAdapter(provider);
    const merchants = await this.merchants.findByProvider(provider);
    if (merchants.length === 0) throw new NotFoundException(`нет включённых мерчантов ${provider}`);

    // несколько аккаунтов одного провайдера: подпись скажет, чей это вебхук
    const merchant = merchants.find((m) => adapter.verifyWebhook(m, req));
    if (!merchant) return { ok: false, reason: "invalid_signature" as const };

    const parsed = adapter.parseWebhook(merchant, req);
    if (!parsed.providerPaymentId) return { ok: false, reason: "no_payment_id" as const };

    const rows = await this.db
      .select()
      .from(schema.payment)
      .where(
        and(
          eq(schema.payment.orgId, this.cfg.defaultOrgId),
          eq(schema.payment.provider, provider),
          eq(schema.payment.providerPaymentId, parsed.providerPaymentId),
        ),
      )
      .limit(1);
    const payment = rows[0];
    if (!payment) return { ok: false, reason: "payment_not_found" as const };

    if (parsed.status !== "paid") {
      if (payment.status === "pending" && parsed.status !== "pending") {
        await this.db.update(schema.payment).set({ status: parsed.status }).where(eq(schema.payment.id, payment.id));
      }
      return { ok: true, status: parsed.status };
    }

    // Сверка суммы: подписи достаточно для подлинности отправителя, но не для того,
    // что оплачено именно столько, сколько выставлено. Без этой проверки корректно
    // подписанный вебхук на 10 ₽ закрывал бы тариф за 500 ₽.
    const amountCheck = this.checkAmount(payment, parsed.amountKopeks);
    if (!amountCheck.ok) {
      this.log.error(
        `payment ${payment.id}: сумма вебхука ${parsed.amountKopeks} не соответствует счёту ${payment.amountKopeks} — не фулфилим`,
      );
      await this.db
        .update(schema.payment)
        .set({ status: "processing", meta: { ...payment.meta, amountMismatch: { got: parsed.amountKopeks } } })
        .where(eq(schema.payment.id, payment.id));
      return { ok: false, reason: "amount_mismatch" as const };
    }

    return this.markPaidAndFulfill(payment.id, parsed.providerRef, parsed.raw);
  }

  /**
   * Недоплату не засчитываем — это ручной разбор.
   * Переплату принимаем: деньги пришли, отказать клиенту в доступе было бы хуже
   * (излишек виден в meta и разбирается вручную).
   * Провайдер, не присылающий сумму (Stars — там сверка в своём контроллере),
   * проверку проходит: сверять нечего.
   */
  private checkAmount(
    payment: typeof schema.payment.$inferSelect,
    got: number | undefined,
  ): { ok: boolean } {
    if (got === undefined || got === null) return { ok: true };
    // допуск в 1 копейку — округления курса на стороне провайдера
    return { ok: got + 1 >= payment.amountKopeks };
  }

  /**
   * Атомарный claim: pending|processing|expired|failed → paid.
   *
   * expired — платёж мог истечь по нашему TTL, а деньги реально пришли.
   * failed — мы сами помечаем платёж failed при ошибке создания счёта и по первому
   * FAIL-вебхуку; если после этого провайдер всё же подтвердит оплату, деньги уже
   * у него, и не зачислить их означает забрать деньги без услуги.
   * Оба перехода логируются как аномалия: это не норма, а спасение оплаты.
   */
  private async markPaidAndFulfill(paymentId: string, providerRef: string | undefined, raw: unknown) {
    const result = await this.fulfillInTransaction(paymentId, providerRef, raw);

    // Атрибуция считается ПОСЛЕ коммита: у сервиса своё подключение к БД, внутри чужой
    // транзакции он не увидит незакоммиченный платёж. Её падение не должно откатывать оплату,
    // поэтому ошибка только логируется — деньги важнее статистики.
    if (!result.alreadyProcessed) {
      try {
        await this.attribution.onPaymentPaid(paymentId);
      } catch (err) {
        this.log.error(`атрибуция платежа ${paymentId} не записана: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return result;
  }

  private async fulfillInTransaction(paymentId: string, providerRef: string | undefined, raw: unknown) {
    return this.db.transaction(async (tx) => {
      const claimed = await tx
        .update(schema.payment)
        .set({
          status: "paid",
          paidAt: new Date(),
          providerRef: providerRef ?? sql`${schema.payment.providerRef}`,
          // не затираем meta целиком: там лежит сырой ответ создания счёта, нужный для разбора
          meta: sql`${schema.payment.meta} || ${JSON.stringify({ webhook: raw ?? null })}::jsonb`,
        })
        .where(
          and(
            eq(schema.payment.id, paymentId),
            inArray(schema.payment.status, ["pending", "processing", "expired", "failed"]),
          ),
        )
        .returning();

      if (claimed.length === 0) {
        this.log.warn(`payment ${paymentId}: повторный вебхук, уже обработан`);
        return { ok: true, alreadyProcessed: true } as const;
      }


      const payment = claimed[0];
      const result = await this.ledger.fulfillPayment(tx, payment);
      return { ok: true, alreadyProcessed: false, ...result } as const;
    });
  }

  private async resolveAmount(input: CreatePaymentInput) {
    if (input.purpose === "topup") {
      if (!input.amountKopeks || input.amountKopeks <= 0) {
        throw new BadRequestException("нужна сумма пополнения");
      }
      return { amountKopeks: input.amountKopeks, plan: null };
    }
    if (!input.planId) throw new BadRequestException("нужен planId");
    const plans = await this.db
      .select()
      .from(schema.plan)
      .where(and(eq(schema.plan.orgId, this.cfg.defaultOrgId), eq(schema.plan.id, input.planId)))
      .limit(1);
    const plan = plans[0];
    if (!plan || !plan.isActive) throw new BadRequestException("тариф недоступен");
    return { amountKopeks: plan.priceKopeks, plan };
  }
}

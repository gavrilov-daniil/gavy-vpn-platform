import { Body, Controller, Inject, Logger, Post } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@corelink/db";
import {
  extractOrderIdFromStarsPayload,
  settingNumber,
  verifyStarsCharge,
  STARS_INTERNAL_CONFIRM_HEADER,
} from "@corelink/payments";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { MerchantService } from "./merchant.service.js";
import { PaymentService } from "./payment.service.js";

/** Тот же дефолт, что у stars-адаптера: курс должен совпасть с тем, по которому выставлен счёт. */
const DEFAULT_STARS_TO_KOPEKS_RATE = 100;

/**
 * Telegram Stars. Внешнего вебхука нет: апдейты приходят в бота, он зовёт эти эндпоинты.
 * Подписи тоже нет — подлинность даёт сам Telegram, а бизнес-проверка это совпадение
 * payload и суммы (иначе счёт на 1 звезду закрыл бы тариф за 500).
 */
@Controller("internal/payments/stars")
export class StarsController {
  private readonly log = new Logger(StarsController.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly payments: PaymentService,
    private readonly merchants: MerchantService,
  ) {}

  /**
   * Ответ на pre_checkout_query. Отказ здесь дешевле, чем принять деньги,
   * которые потом не к чему привязать.
   */
  @Post("pre-checkout")
  async preCheckout(@Body() body: { invoicePayload: string; totalAmount: number; telegramUserId: number }) {
    const orderId = extractOrderIdFromStarsPayload(body.invoicePayload ?? "");
    if (!orderId) return { ok: false, reason: "unknown_payload_format" };

    const payment = await this.findByOrderId(orderId);
    if (!payment) return { ok: false, reason: "payment_not_found" };
    if (payment.status === "paid") return { ok: false, reason: "already_paid" };

    const expectedStars = await this.expectedStars(payment);
    if (body.totalAmount !== expectedStars) {
      this.log.warn(`stars pre-checkout: сумма не совпала (${body.totalAmount} ≠ ${expectedStars})`);
      return { ok: false, reason: "amount_mismatch" };
    }
    return { ok: true, paymentId: payment.id };
  }

  /**
   * Подтверждение successful_payment. Идёт тем же путём, что и вебхуки остальных
   * провайдеров — атомарный claim статуса + ledger, поэтому повтор безопасен.
   */
  @Post("confirm")
  async confirm(
    @Body()
    body: {
      invoicePayload: string;
      totalAmount: number;
      telegramPaymentChargeId: string;
      telegramUserId: number;
    },
  ) {
    const orderId = extractOrderIdFromStarsPayload(body.invoicePayload ?? "");
    if (!orderId) return { ok: false, reason: "unknown_payload_format" };

    const payment = await this.findByOrderId(orderId);
    if (!payment) return { ok: false, reason: "payment_not_found" };

    const expectedStars = await this.expectedStars(payment);
    const check = verifyStarsCharge({
      invoicePayload: body.invoicePayload,
      totalAmount: body.totalAmount,
      expectedAmountStars: expectedStars,
    });
    if (!check.ok) {
      // деньги уже списаны Telegram — это инцидент для ручного разбора, а не молчаливый отказ
      this.log.error(`stars confirm: ${check.reason}, charge=${body.telegramPaymentChargeId}`);
      return { ok: false, reason: check.reason };
    }

    const result = await this.payments.handleWebhook("stars", {
      rawBody: JSON.stringify({
        invoice_payload: body.invoicePayload,
        telegram_payment_charge_id: body.telegramPaymentChargeId,
        total_amount: body.totalAmount,
      }),
      // маркер говорит stars-адаптеру, что сумма уже сверена здесь, а запрос не с улицы
      headers: { [STARS_INTERNAL_CONFIRM_HEADER]: "1" },
    });

    return { ...result, paymentId: payment.id };
  }

  /**
   * Курс берём у мерчанта платежа — тем же путём, каким его брал адаптер при выставлении счёта.
   * Захардкоженные 100 копеек за звезду ломали канал при любом другом курсе: сумма из Telegram
   * никогда не сходилась с ожидаемой и pre-checkout всегда отвечал amount_mismatch.
   */
  private async expectedStars(payment: typeof schema.payment.$inferSelect): Promise<number> {
    let rate = DEFAULT_STARS_TO_KOPEKS_RATE;
    if (payment.merchantId) {
      const merchant = await this.merchants.getConfig(payment.merchantId);
      rate = settingNumber(merchant, "stars_to_kopeks_rate", DEFAULT_STARS_TO_KOPEKS_RATE);
    }
    return Math.max(1, Math.ceil(payment.amountKopeks / rate));
  }

  private async findByOrderId(orderId: string) {
    const [row] = await this.db
      .select()
      .from(schema.payment)
      .where(
        and(
          eq(schema.payment.orgId, this.cfg.defaultOrgId),
          eq(schema.payment.provider, "stars"),
          eq(schema.payment.providerPaymentId, orderId),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}

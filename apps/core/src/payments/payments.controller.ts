import { Body, Controller, Get, Headers, Logger, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { PROVIDER_SPECS, STARS_INTERNAL_CONFIRM_HEADER } from "@vpn/payments";
import { PaymentService } from "./payment.service.js";
import { MerchantService } from "./merchant.service.js";
import { IdempotencyService } from "../common/idempotency.service.js";

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@Controller()
export class PaymentsController {
  private readonly log = new Logger(PaymentsController.name);

  constructor(
    private readonly payments: PaymentService,
    private readonly merchants: MerchantService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /**
   * Вебхук платёжного провайдера.
   * Подпись считается по СЫРОМУ телу: ре-сериализованный JSON меняет байты и ломает проверку.
   * Ответ всегда 200 при внутренней ошибке — иначе провайдер завалит ретраями;
   * невалидная подпись — 401, до всякой обработки.
   */
  @Post("webhooks/:provider")
  async webhook(
    @Param("provider") provider: string,
    @Req() req: RawBodyRequest,
    @Res() res: Response,
  ): Promise<void> {
    // У Stars внешнего вебхука нет: Telegram шлёт successful_payment боту, и подтверждение
    // приходит на internal/payments/stars/confirm, где сверяется сумма. Публичная точка без
    // подписи означала бы «зачисли себе любую сумму бесплатно».
    if (provider.toLowerCase() === "stars") {
      this.log.warn("webhook stars: публичного вебхука у Stars нет, запрос отклонён");
      res.status(404).send({ ok: false });
      return;
    }

    const rawBody = req.rawBody?.toString("utf8") ?? JSON.stringify(req.body ?? {});
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      // маркер внутреннего подтверждения снаружи прийти не может
      if (key === STARS_INTERNAL_CONFIRM_HEADER) continue;
      if (typeof v === "string") headers[key] = v;
    }

    try {
      const result = await this.payments.handleWebhook(provider, { rawBody, headers });
      if (!result.ok && result.reason === "invalid_signature") {
        this.log.warn(`webhook ${provider}: невалидная подпись`);
        res.status(401).send({ ok: false });
        return;
      }
      res.status(200).send({ ok: true });
    } catch (err) {
      this.log.error(`webhook ${provider} упал: ${err instanceof Error ? err.message : String(err)}`);
      res.status(200).send({ ok: true }); // не провоцируем шторм ретраев
    }
  }

  /** Способы оплаты, доступные пользователю прямо сейчас. */
  @Get("internal/payments/methods/:purpose")
  async methods(@Param("purpose") purpose: string) {
    const rows = await this.merchants.listAvailable(purpose as "topup" | "plan" | "gift");
    return rows.map((m) => ({
      merchantId: m.id,
      provider: m.provider,
      title: m.title ?? m.alias,
      settings: { assets: m.settings.assets ?? undefined },
    }));
  }

  /**
   * Создание счёта. Идемпотентно по заголовку x-client-request-id:
   * дабл-тап по кнопке оплаты в боте не должен создавать два счёта у провайдера.
   */
  @Post("internal/payments/create")
  async create(
    @Body()
    body: {
      subscriberId: string;
      merchantId: string;
      purpose: "topup" | "plan" | "gift";
      amountKopeks?: number;
      planId?: string;
      asset?: string;
      method?: string;
      telegramUserId?: number;
    },
    @Headers("x-client-request-id") clientRequestId?: string,
  ) {
    return this.idempotency.run("payment-create", clientRequestId, async () => {
      const { payment, invoice } = await this.payments.createPayment(body);
      return {
        paymentId: payment.id,
        provider: payment.provider,
        amountKopeks: payment.amountKopeks,
        payUrl: invoice.payUrl,
        cryptoAsset: invoice.cryptoAsset,
        cryptoAmount: invoice.cryptoAmount,
        deferredToBot: invoice.deferredToBot,
        expiresAt: invoice.expiresAt,
      };
    });
  }

  /** Спеки провайдеров — админка рисует форму подключения по ним. */
  @Get("v1/payments/provider-specs")
  specs() {
    return PROVIDER_SPECS;
  }
}

import { Injectable, Logger } from "@nestjs/common";
import { request } from "@vpn/core-kit";
import { loadConfig } from "../config.js";

export interface PlanDto {
  id: string;
  code: string;
  title: string;
  periodDays: number;
  priceKopeks: number;
  trafficGb: number | null;
  deviceLimit: number | null;
  isTrial: boolean;
  sortOrder: number;
}

export interface PaymentMethodDto {
  merchantId: string;
  provider: string;
  title: string;
  settings?: { assets?: string[] };
}

export interface CreatedPaymentDto {
  paymentId: string;
  provider: string;
  amountKopeks: number;
  payUrl?: string;
  cryptoAsset?: string;
  cryptoAmount?: string;
  /** Stars: счёт выставляет бот через replyWithInvoice, HTTP-вызова к провайдеру нет. */
  deferredToBot?: { payload: string; amountStars: number };
  expiresAt?: string;
}

export interface SubscriberDto {
  subscriberId: string;
  isNew: boolean;
}

export interface OverviewDto {
  subscriberId: string;
  balanceKopeks: number;
  trialAvailable: boolean;
  subscription: {
    status: string;
    expireAt: string | null;
    subscriptionUrl: string;
    usedTrafficBytes: number;
    trafficLimitBytes: number | null;
    deviceLimit: number | null;
  } | null;
  referral: { code: string; invitedCount: number; earnedKopeks: number };
  devices: { model: string | null; os: string | null; lastSeenAt: string | null }[];
}

export interface TrialResultDto {
  ok: boolean;
  reason?: string;
  subscriptionUrl?: string;
  expireAt?: string;
}

export interface StarsVerdictDto {
  ok: boolean;
  reason?: string;
}

export interface StarsConfirmDto {
  ok: boolean;
  alreadyProcessed?: boolean;
  planTitle?: string;
  expireAt?: string;
  amountKopeks?: number;
}

/**
 * Единственная точка общения бота с core. Своей БД у бота нет: любой экран —
 * это запрос сюда, поэтому таймауты короткие, а на записи ретраи выключены.
 */
@Injectable()
export class CoreApiClient {
  private readonly log = new Logger(CoreApiClient.name);
  private readonly cfg = loadConfig();

  resolveSubscriber(input: {
    telegramId: number;
    username?: string;
    languageCode?: string;
    startPayload?: string;
  }): Promise<SubscriberDto> {
    return this.post<SubscriberDto>("/internal/subscribers/resolve", input);
  }

  listPlans(): Promise<PlanDto[]> {
    return this.get<PlanDto[]>("/v1/plans");
  }

  listPaymentMethods(purpose: "topup" | "plan" | "gift"): Promise<PaymentMethodDto[]> {
    return this.get<PaymentMethodDto[]>(`/v1/payments/methods/${purpose}`);
  }

  createPayment(
    input: {
      subscriberId: string;
      merchantId: string;
      purpose: "topup" | "plan" | "gift";
      amountKopeks?: number;
      planId?: string;
      telegramUserId: number;
    },
    clientRequestId: string,
  ): Promise<CreatedPaymentDto> {
    return this.post<CreatedPaymentDto>("/v1/payments/create", input, clientRequestId);
  }

  getOverview(subscriberId: string): Promise<OverviewDto> {
    return this.get<OverviewDto>(`/internal/subscribers/${subscriberId}/overview`);
  }

  activateTrial(subscriberId: string, clientRequestId: string): Promise<TrialResultDto> {
    return this.post<TrialResultDto>("/internal/subscriptions/trial", { subscriberId }, clientRequestId);
  }

  starsPreCheckout(input: {
    invoicePayload: string;
    totalAmount: number;
    telegramUserId: number;
  }): Promise<StarsVerdictDto> {
    return this.post<StarsVerdictDto>("/internal/payments/stars/pre-checkout", input);
  }

  starsConfirm(
    input: {
      invoicePayload: string;
      totalAmount: number;
      telegramPaymentChargeId: string;
      telegramUserId: number;
    },
    clientRequestId: string,
  ): Promise<StarsConfirmDto> {
    return this.post<StarsConfirmDto>("/internal/payments/stars/confirm", input, clientRequestId);
  }

  supportInbound(input: {
    telegramUserId: number;
    username?: string;
    languageCode?: string;
    text: string;
    updateId: number;
    telegramMessageId: number;
  }): Promise<void> {
    return this.post<void>("/internal/support/inbound", input);
  }

  /** Аналитика не имеет права ронять ответ юзеру — глушим всё здесь. */
  async trackEvent(event: {
    event: string;
    telegramUserId?: number;
    updateId?: number;
    payload: Record<string, unknown>;
  }): Promise<void> {
    try {
      await request(`${this.cfg.coreApiUrl}/internal/bot-events/track`, {
        method: "POST",
        json: event,
        headers: this.headers(),
        provider: "core-api",
        timeoutMs: 2_000,
        retries: 0,
      });
    } catch (err) {
      this.log.debug(`не отправлено событие ${event.event}: ${message(err)}`);
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await request<T>(`${this.cfg.coreApiUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
      provider: "core-api",
      timeoutMs: 8_000,
      retries: 2,
    });
    return res.body;
  }

  private async post<T>(path: string, json: unknown, clientRequestId?: string): Promise<T> {
    const headers = this.headers();
    // Ретраев нет: повтор создаст второй платёж. Дедуп — на стороне core по этому заголовку.
    if (clientRequestId) headers["x-client-request-id"] = clientRequestId;
    const res = await request<T>(`${this.cfg.coreApiUrl}${path}`, {
      method: "POST",
      json,
      headers,
      provider: "core-api",
      timeoutMs: 15_000,
      retries: 0,
    });
    return res.body;
  }

  private headers(): Record<string, string> {
    return { "x-service-token": this.cfg.serviceToken };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

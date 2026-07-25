import { BadRequestException, Body, Controller, Post } from "@nestjs/common";
import { AttributionService } from "./attribution.service.js";
import { EventsService } from "./events.service.js";

/** Точки входа для бота: события воронки и атрибуция по deep-link. */
@Controller("internal/crm")
export class CrmInternalController {
  constructor(
    private readonly events: EventsService,
    private readonly attribution: AttributionService,
  ) {}

  @Post("events")
  track(
    @Body()
    body: {
      event: string;
      telegramUserId?: number;
      subscriberId?: string;
      updateId?: number;
      payload?: Record<string, unknown>;
    },
  ) {
    if (!body.event) throw new BadRequestException("нужен event");
    return this.events.track(body);
  }

  /** Бот шлёт сырой start-payload; невалидный код здесь не ошибка, а органика. */
  @Post("attribution/registration")
  async registration(@Body() body: { subscriberId: string; startPayload?: string }) {
    if (!body.subscriberId) throw new BadRequestException("нужен subscriberId");
    const link = await this.attribution.resolveStartPayload(body.startPayload);
    if (!link) return { attributed: false as const, reason: "organic" as const };
    const result = await this.attribution.onRegistration(body.subscriberId, link.id);
    return { attributed: true as const, code: link.code, ...result };
  }

  @Post("attribution/payment")
  payment(@Body() body: { paymentId: string }) {
    if (!body.paymentId) throw new BadRequestException("нужен paymentId");
    return this.attribution.onPaymentPaid(body.paymentId);
  }
}

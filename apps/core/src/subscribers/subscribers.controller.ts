import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { SubscribersService } from "./subscribers.service.js";

@Controller()
export class SubscribersController {
  constructor(private readonly subscribers: SubscribersService) {}

  /** Бот зовёт на каждый /start: найти подписчика или создать. */
  @Post("internal/subscribers/resolve")
  resolve(
    @Body()
    body: {
      telegramId: number;
      username?: string;
      languageCode?: string;
      campaignLinkId?: string;
      referrerSubscriberId?: string;
    },
  ) {
    return this.subscribers.resolve(body);
  }

  @Get("internal/subscribers/:id/overview")
  overview(@Param("id") id: string) {
    return this.subscribers.overview(id);
  }

  @Get("v1/plans")
  plans() {
    return this.subscribers.listPlans();
  }

  @Post("internal/subscriptions/trial")
  trial(@Body() body: { subscriberId: string }) {
    return this.subscribers.activateTrial(body.subscriberId);
  }
}

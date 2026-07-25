import { Module } from "@nestjs/common";
import { BotModule } from "../bot/bot.module.js";
import { SubscriptionController } from "./subscription.controller.js";
import { SubscriptionService } from "./subscription.service.js";
import { SubscriptionRepository } from "./subscription.repository.js";

@Module({
  imports: [BotModule],
  controllers: [SubscriptionController],
  providers: [SubscriptionService, SubscriptionRepository],
})
export class SubscriptionModule {}

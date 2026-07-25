import { Module } from "@nestjs/common";
import { SubscribersController } from "./subscribers.controller.js";
import { SubscribersService } from "./subscribers.service.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { CrmModule } from "../crm/crm.module.js";

@Module({
  imports: [PaymentsModule, CrmModule], // LedgerService для баланса, AttributionService для атрибуции
  controllers: [SubscribersController],
  providers: [SubscribersService],
  exports: [SubscribersService],
})
export class SubscribersModule {}

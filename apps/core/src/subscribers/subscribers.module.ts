import { Module } from "@nestjs/common";
import { SubscribersController } from "./subscribers.controller.js";
import { SubscribersService } from "./subscribers.service.js";
import { PaymentsModule } from "../payments/payments.module.js";

@Module({
  imports: [PaymentsModule], // нужен LedgerService для баланса
  controllers: [SubscribersController],
  providers: [SubscribersService],
  exports: [SubscribersService],
})
export class SubscribersModule {}

import { Module } from "@nestjs/common";
import { PaymentsController } from "./payments.controller.js";
import { MerchantsAdminController } from "./merchants.admin.controller.js";
import { StarsController } from "./stars.controller.js";
import { PaymentService } from "./payment.service.js";
import { MerchantService } from "./merchant.service.js";
import { LedgerService } from "./ledger.service.js";

@Module({
  controllers: [PaymentsController, MerchantsAdminController, StarsController],
  providers: [PaymentService, MerchantService, LedgerService],
  exports: [PaymentService, MerchantService, LedgerService],
})
export class PaymentsModule {}

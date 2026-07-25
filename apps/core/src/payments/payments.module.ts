import { Module } from "@nestjs/common";
import { PaymentsController } from "./payments.controller.js";
import { MerchantsAdminController } from "./merchants.admin.controller.js";
import { StarsController } from "./stars.controller.js";
import { PaymentService } from "./payment.service.js";
import { MerchantService } from "./merchant.service.js";
import { LedgerService } from "./ledger.service.js";
import { CrmModule } from "../crm/crm.module.js";

@Module({
  imports: [CrmModule], // атрибуция оплаченного платежа (после коммита транзакции)
  controllers: [PaymentsController, MerchantsAdminController, StarsController],
  providers: [PaymentService, MerchantService, LedgerService],
  exports: [PaymentService, MerchantService, LedgerService],
})
export class PaymentsModule {}

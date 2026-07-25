import { Controller, Get, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ServiceTokenGuard } from "./common/service-token.guard.js";
import { DbModule } from "./db/db.module.js";
import { SubscriptionModule } from "./subscription/subscription.module.js";
import { AdminModule } from "./admin/admin.module.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { SupportModule } from "./support/support.module.js";
import { CrmModule } from "./crm/crm.module.js";
import { BroadcastModule } from "./broadcast/broadcast.module.js";
import { NodesModule } from "./nodes/nodes.module.js";
import { SubscribersModule } from "./subscribers/subscribers.module.js";
import { WorkersModule } from "./workers/workers.module.js";

@Controller()
class HealthController {
  @Get("healthz")
  health() {
    return { ok: true };
  }
}

@Module({
  imports: [
    DbModule,
    SubscriptionModule,
    AdminModule,
    PaymentsModule,
    NodesModule,
    SubscribersModule,
    SupportModule,
    CrmModule,
    BroadcastModule,
    WorkersModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ServiceTokenGuard }],
})
export class AppModule {}

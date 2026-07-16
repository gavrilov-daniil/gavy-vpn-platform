import { Controller, Get, Module } from "@nestjs/common";
import { DbModule } from "./db/db.module.js";
import { SubscriptionModule } from "./subscription/subscription.module.js";
import { AdminModule } from "./admin/admin.module.js";

@Controller()
class HealthController {
  @Get("healthz")
  health() {
    return { ok: true };
  }
}

@Module({
  imports: [DbModule, SubscriptionModule, AdminModule],
  controllers: [HealthController],
})
export class AppModule {}

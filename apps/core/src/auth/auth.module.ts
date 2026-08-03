import { Global, Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { TelegramAuthService } from "./telegram-auth.service.js";

/** Global: AdminGuard живёт в APP_GUARD и должен видеть AuthService без импорта в каждый модуль. */
@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, TelegramAuthService],
  exports: [AuthService, TelegramAuthService],
})
export class AuthModule {}

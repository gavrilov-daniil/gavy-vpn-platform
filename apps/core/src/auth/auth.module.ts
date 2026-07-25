import { Global, Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";

/** Global: AdminGuard живёт в APP_GUARD и должен видеть AuthService без импорта в каждый модуль. */
@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}

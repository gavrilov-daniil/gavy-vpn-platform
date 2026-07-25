import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { loadConfig } from "../config.js";

/**
 * Гейт на служебные эндпоинты. Всё под /internal/* вызывается только своими сервисами
 * (бот, воркеры), наружу торчать не должно.
 *
 * /internal/agent/* исключён: у node-agent свой секрет (x-agent-token), он проверяется
 * в самом контроллере — агент живёт на чужой машине и общий сервисный токен ему не даём.
 *
 * Если SERVICE_TOKEN не задан (локальная разработка) — гейт пропускает, но пишет предупреждение
 * при старте, чтобы это не уехало в прод незамеченным.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  private readonly cfg = loadConfig();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const path = req.path ?? req.url ?? "";

    if (!path.startsWith("/internal/")) return true;
    if (path.startsWith("/internal/agent/")) return true;
    if (!this.cfg.serviceToken) return true;

    const provided = req.headers["x-service-token"];
    if (provided !== this.cfg.serviceToken) {
      throw new UnauthorizedException("невалидный service token");
    }
    return true;
  }
}

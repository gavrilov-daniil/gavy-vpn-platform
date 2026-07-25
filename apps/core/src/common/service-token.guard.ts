import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { safeCompare } from "@vpn/core-kit";
import { loadConfig } from "../config.js";
import { headerValue, isUnderPrefix, normalizedPath } from "./request-path.js";

export const INTERNAL_PATH_PREFIX = "/internal";
export const AGENT_PATH_PREFIX = "/internal/agent";
export const SERVICE_TOKEN_HEADER = "x-service-token";

/**
 * Гейт на служебные эндпоинты. Всё под /internal/* вызывается только своими сервисами
 * (бот, воркеры), наружу торчать не должно.
 *
 * /internal/agent/* исключён: у node-agent свой секрет (x-agent-token), он проверяется
 * в самом контроллере — агент живёт на чужой машине и общий сервисный токен ему не даём.
 *
 * Fail-closed: пустой SERVICE_TOKEN закрывает раздел, а не открывает его. Раньше было
 * наоборот, и пустая переменная из .env.example делала /internal/* публичным.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  private readonly cfg = loadConfig();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const path = normalizedPath(req);

    if (!isUnderPrefix(path, INTERNAL_PATH_PREFIX)) return true;
    if (isUnderPrefix(path, AGENT_PATH_PREFIX)) return true;

    if (!this.cfg.serviceToken) {
      throw new UnauthorizedException("SERVICE_TOKEN не задан: служебный API закрыт");
    }

    const provided = headerValue(req, SERVICE_TOKEN_HEADER);
    if (!provided || !safeCompare(provided, this.cfg.serviceToken)) {
      throw new UnauthorizedException("невалидный service token");
    }
    return true;
  }
}

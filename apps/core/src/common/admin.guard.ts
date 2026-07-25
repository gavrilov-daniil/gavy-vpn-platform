import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { safeCompare } from "@vpn/core-kit";
import { loadConfig } from "../config.js";
import { headerValue, isUnderPrefix, normalizedPath } from "./request-path.js";

export const ADMIN_PATH_PREFIX = "/api/admin";
export const ADMIN_TOKEN_HEADER = "x-admin-token";

/**
 * Гейт на админский API. За /api/admin/* лежат дамп базы подписчиков, правка мерчантов,
 * рассылки от имени бота и массовые операции по нодам — анонимно туда пускать нечего.
 *
 * Fail-closed: пустой ADMIN_TOKEN не «отключает проверку для локальной разработки», а
 * закрывает раздел целиком (401). Иначе забытая переменная в проде = открытая админка.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly cfg = loadConfig();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const path = normalizedPath(req);

    if (!isUnderPrefix(path, ADMIN_PATH_PREFIX)) return true;

    if (!this.cfg.adminToken) {
      throw new UnauthorizedException("ADMIN_TOKEN не задан: админский API закрыт");
    }

    const provided = headerValue(req, ADMIN_TOKEN_HEADER);
    if (!provided || !safeCompare(provided, this.cfg.adminToken)) {
      throw new UnauthorizedException("невалидный admin token");
    }
    return true;
  }
}

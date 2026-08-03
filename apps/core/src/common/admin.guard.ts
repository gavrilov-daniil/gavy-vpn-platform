import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { safeCompare } from "@corelink/core-kit";
import { loadConfig } from "../config.js";
import { AuthService } from "../auth/auth.service.js";
import { headerValue, isUnderPrefix, normalizedPath } from "./request-path.js";

export const ADMIN_PATH_PREFIX = "/api/admin";
export const ADMIN_TOKEN_HEADER = "x-admin-token";

/** Вход и проверка сессии не могут требовать сессию — иначе войти невозможно. */
const PUBLIC_ADMIN_PATHS = ["/api/admin/auth/login"];

/**
 * Гейт на админский API. За /api/admin/* лежат дамп базы подписчиков, правка мерчантов,
 * рассылки от имени бота и массовые операции по нодам — анонимно туда пускать нечего.
 *
 * Два способа входа:
 *   1) сессия оператора (`x-admin-token` = токен сессии) — основной: у каждого свой
 *      пароль, доступ отзывается поимённо, в логе видно кто что делал;
 *   2) общий `ADMIN_TOKEN` из env — переходный, чтобы не сломать доступ до заведения
 *      учёток. Его стоит убрать, как только операторы созданы.
 *
 * Fail-closed: если не задан ни общий токен, ни учётки — раздел закрыт целиком (401).
 * Иначе забытая переменная в проде = открытая админка.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly cfg = loadConfig();

  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const path = normalizedPath(req);

    if (!isUnderPrefix(path, ADMIN_PATH_PREFIX)) return true;
    if (PUBLIC_ADMIN_PATHS.includes(path)) return true;

    const provided = headerValue(req, ADMIN_TOKEN_HEADER);
    if (!provided) throw new UnauthorizedException("нужен admin token или сессия");

    // сессия оператора — основной путь
    const session = await this.auth.resolveSession(provided);
    if (session) {
      (req as Request & { operator?: unknown }).operator = session;
      return true;
    }

    // переходный общий токен
    if (this.cfg.adminToken && safeCompare(provided, this.cfg.adminToken)) return true;

    throw new UnauthorizedException("невалидный admin token");
  }
}

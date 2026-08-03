import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { safeCompare } from "@corelink/core-kit";
import { loadConfig } from "../config.js";
import { AuthService } from "../auth/auth.service.js";
import {
  DEFAULT_MIN_ROLE,
  isPublicRoute,
  MIN_ROLE_METADATA,
  roleAtLeast,
  type OperatorContext,
  type RouteAccess,
} from "../auth/roles.js";
import { headerValue, isUnderPrefix, normalizedPath } from "./request-path.js";

export const ADMIN_PATH_PREFIX = "/api/admin";
export const ADMIN_TOKEN_HEADER = "x-admin-token";

/**
 * Гейт на админский API. За /api/admin/* лежат дамп базы подписчиков, правка мерчантов,
 * рассылки от имени бота и массовые операции по нодам — анонимно туда пускать нечего.
 *
 * Два способа входа:
 *   1) сессия оператора (`x-admin-token` = токен сессии) — основной: у каждого свой
 *      пароль либо привязанный Telegram, доступ отзывается поимённо, в логе видно кто что делал;
 *   2) общий `ADMIN_TOKEN` из env — переходный, им заводится первая учётка. Считается
 *      superadmin'ом: иначе первого настоящего superadmin'а неоткуда взять. Убрать, как
 *      только тот заведён.
 *
 * Роль проверяется здесь же: маршрут объявляет минимальную через @MinRole, без декоратора
 * действует `admin`, а @PublicRoute снимает требование сессии (вход и то, из чего рисуется
 * форма входа). Fail-closed дважды: нет ни общего токена, ни учёток → раздел закрыт
 * целиком (401); роль ниже требуемой → 403, даже если сессия валидна.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly cfg = loadConfig();

  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const path = normalizedPath(req);

    if (!isUnderPrefix(path, ADMIN_PATH_PREFIX)) return true;

    const required = this.requiredAccess(context);
    if (isPublicRoute(required)) return true;

    const provided = headerValue(req, ADMIN_TOKEN_HEADER);
    if (!provided) throw new UnauthorizedException("нужен admin token или сессия");

    const operator = await this.resolve(provided);
    if (!operator) throw new UnauthorizedException("невалидный admin token");

    if (!roleAtLeast(operator.role, required)) {
      throw new ForbiddenException(`недостаточно прав: нужна роль ${required}`);
    }

    (req as Request & { operator?: OperatorContext }).operator = operator;
    return true;
  }

  private async resolve(token: string): Promise<OperatorContext | null> {
    const session = await this.auth.resolveSession(token);
    if (session) return { ...session, viaSharedToken: false };

    if (this.cfg.adminToken && safeCompare(token, this.cfg.adminToken)) {
      return {
        operatorId: null,
        email: null,
        displayName: null,
        telegramUsername: null,
        role: "superadmin",
        hasPassword: false,
        hasTelegram: false,
        viaSharedToken: true,
      };
    }

    return null;
  }

  /** Хендлер важнее класса: контроллер задаёт общий уровень, метод — своё исключение. */
  private requiredAccess(context: ExecutionContext): RouteAccess {
    return (
      this.reflector.getAllAndOverride<RouteAccess | undefined>(MIN_ROLE_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_MIN_ROLE
    );
  }
}

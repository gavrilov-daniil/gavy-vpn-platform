import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { OperatorContext } from "./roles.js";

/**
 * Оператор текущего запроса. Кладёт его AdminGuard — до хендлера запрос без
 * валидной сессии или общего токена не доходит, поэтому пустой контекст здесь
 * означал бы, что декоратор повесили на маршрут вне /api/admin/*.
 */
export const Operator = createParamDecorator((_data: unknown, ctx: ExecutionContext): OperatorContext => {
  const req = ctx.switchToHttp().getRequest<Request & { operator?: OperatorContext }>();
  if (!req.operator) throw new UnauthorizedException("нет контекста оператора");
  return req.operator;
});

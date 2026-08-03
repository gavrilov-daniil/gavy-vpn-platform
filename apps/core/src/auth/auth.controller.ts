import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service.js";
import { Operator } from "./operator.decorator.js";
import { MinRole, PublicRoute, requireOwnOperatorId, type OperatorContext } from "./roles.js";
import { TelegramAuthService, type TelegramLoginPayload } from "./telegram-auth.service.js";

/**
 * Вход и управление учётками. Без @MinRole действует `admin` — то есть всё, что
 * заводит и правит операторов, закрыто от support по умолчанию; собственный профиль
 * и выход помечены `support` явно.
 */
@Controller("api/admin/auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly telegram: TelegramAuthService,
  ) {}

  @Post("login")
  @PublicRoute()
  async login(@Body() body: { email: string; password: string }, @Req() req: Request) {
    if (!body?.email || !body?.password) throw new UnauthorizedException("нужны email и пароль");
    return this.auth.login({
      email: body.email,
      password: body.password,
      userAgent: req.headers["user-agent"] as string | undefined,
      ip: req.ip,
    });
  }

  /** Публично: страница входа рисует кнопку Telegram, только если он настроен и включён. */
  @Get("telegram/config")
  @PublicRoute()
  telegramConfig() {
    return this.telegram.publicConfig();
  }

  /**
   * Вход по Telegram Login Widget. Незнакомый аккаунт получает `status: pending` —
   * это заявка, которую подтверждает админ. Сессии в таком ответе нет.
   */
  @Post("telegram/login")
  @PublicRoute()
  telegramLogin(@Body() body: TelegramLoginPayload, @Req() req: Request) {
    if (!body?.id || !body?.hash) throw new BadRequestException("нет данных Telegram");
    return this.auth.loginWithTelegram({
      payload: body,
      userAgent: req.headers["user-agent"] as string | undefined,
      ip: req.ip,
    });
  }

  @Post("logout")
  @MinRole("support")
  logout(@Headers("x-admin-token") token?: string) {
    if (!token) return { ok: true };
    return this.auth.logout(token);
  }

  /**
   * Кто я — по этому админка рисует имя оператора и набор доступных экранов.
   * Профиль целиком приходит из гварда: он уже прочитал учётку, резолвя сессию.
   */
  @Get("me")
  @MinRole("support")
  me(@Operator() operator: OperatorContext) {
    return operator;
  }

  /** Привязка Telegram к своей учётке: после неё вход работает обоими способами. */
  @Post("telegram/link")
  @MinRole("support")
  linkTelegram(@Body() body: TelegramLoginPayload, @Operator() operator: OperatorContext) {
    if (!body?.id || !body?.hash) throw new BadRequestException("нет данных Telegram");
    return this.auth.linkTelegram(body, operator);
  }

  @Delete("telegram/link")
  @MinRole("support")
  unlinkOwnTelegram(@Operator() operator: OperatorContext) {
    return this.auth.unlinkTelegram(requireOwnOperatorId(operator), operator);
  }

  /** Смена собственного пароля. Чужой — через operators/:id/password. */
  @Post("password")
  @MinRole("support")
  changeOwnPassword(@Body() body: { password: string }, @Operator() operator: OperatorContext) {
    return this.auth.changePassword(requireOwnOperatorId(operator), body?.password ?? "", operator);
  }

  // --- управление учётками: admin и выше --------------------------------------

  @Get("operators")
  listOperators() {
    return this.auth.listOperators();
  }

  @Post("operators")
  createOperator(
    @Body() body: { email: string; password: string; role?: string; displayName?: string },
    @Operator() operator: OperatorContext,
  ) {
    return this.auth.createOperator(body, operator);
  }

  @Post("operators/:id/approve")
  approve(@Param("id") id: string, @Body() body: { role: string }, @Operator() operator: OperatorContext) {
    return this.auth.approveOperator(id, body?.role ?? "support", operator);
  }

  @Patch("operators/:id")
  update(
    @Param("id") id: string,
    @Body() body: { role?: string; status?: "active" | "disabled" },
    @Operator() operator: OperatorContext,
  ) {
    if (body?.role === undefined && body?.status === undefined) {
      throw new BadRequestException("нечего менять: ожидается role или status");
    }
    return this.auth.updateOperator(id, body, operator);
  }

  @Post("operators/:id/password")
  changePassword(@Param("id") id: string, @Body() body: { password: string }, @Operator() operator: OperatorContext) {
    return this.auth.changePassword(id, body?.password ?? "", operator);
  }

  @Delete("operators/:id/telegram")
  unlinkTelegram(@Param("id") id: string, @Operator() operator: OperatorContext) {
    return this.auth.unlinkTelegram(id, operator);
  }

  // --- настройки входа по Telegram --------------------------------------------

  @Get("telegram/settings")
  telegramSettings() {
    return this.telegram.settingsForAdmin();
  }

  @Patch("telegram/settings")
  updateTelegramSettings(@Body() body: { isEnabled?: boolean; botUsername?: string; botToken?: string }) {
    return this.telegram.updateSettings(body ?? {});
  }
}

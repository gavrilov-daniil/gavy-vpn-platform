import { Body, Controller, Delete, Get, Headers, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service.js";

@Controller("api/admin/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  async login(@Body() body: { email: string; password: string }, @Req() req: Request) {
    if (!body?.email || !body?.password) throw new UnauthorizedException("нужны email и пароль");
    return this.auth.login({
      email: body.email,
      password: body.password,
      userAgent: req.headers["user-agent"] as string | undefined,
      ip: req.ip,
    });
  }

  @Post("logout")
  async logout(@Headers("x-admin-token") token?: string) {
    if (!token) return { ok: true };
    return this.auth.logout(token);
  }

  /** Кто я — админка рисует по этому имя оператора и его роль. */
  @Get("me")
  async me(@Headers("x-admin-token") token?: string) {
    if (!token) throw new UnauthorizedException("нет сессии");
    const session = await this.auth.resolveSession(token);
    if (!session) throw new UnauthorizedException("сессия истекла");
    return session;
  }

  @Get("operators")
  listOperators() {
    return this.auth.listOperators();
  }

  @Post("operators")
  createOperator(@Body() body: { email: string; password: string; role?: string }) {
    return this.auth.createOperator(body);
  }

  @Post("operators/:id/password")
  changePassword(@Body() body: { userId: string; password: string }) {
    return this.auth.changePassword(body.userId, body.password);
  }

  @Delete("operators/:id")
  disable(@Body() body: { userId: string }) {
    return this.auth.disableOperator(body.userId);
  }
}

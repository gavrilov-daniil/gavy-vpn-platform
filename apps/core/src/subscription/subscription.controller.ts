import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { clientIp } from "../common/client-ip.js";
import { headerValue } from "../common/request-path.js";
import { loadConfig } from "../config.js";
import { SubscriptionService, type DeliveryRequest } from "./subscription.service.js";

// Пути ОБЯЗАНЫ совпадать с тем, что сохранено у мигрированных клиентов (migration.md P0-2):
//   /auto/<shortUuid>  — мульти-профильная подписка
//   /api/sub/<id>      — legacy базовый Авто
@Controller()
export class SubscriptionController {
  private readonly cfg = loadConfig();

  constructor(private readonly service: SubscriptionService) {}

  @Get("auto/:shortUuid")
  async auto(
    @Param("shortUuid") shortUuid: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const r = await this.service.deliverByShortUuid(shortUuid, this.describe(req));
    res.status(r.status).set(r.headers).send(r.body);
  }

  @Get("api/sub/:id")
  async legacy(@Param("id") id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const r = await this.service.deliverById(id, this.describe(req));
    res.status(r.status).set(r.headers).send(r.body);
  }

  /** Заголовки устройства шлёт Happ; их отсутствие — штатный случай, не ошибка. */
  private describe(req: Request): DeliveryRequest {
    return {
      ip: clientIp(req, this.cfg.subRateLimitTrustProxy),
      userAgent: headerValue(req, "user-agent"),
      hwid: headerValue(req, "x-hwid") || undefined,
      deviceOs: headerValue(req, "x-device-os") || undefined,
      osVer: headerValue(req, "x-ver-os") || undefined,
      deviceModel: headerValue(req, "x-device-model") || undefined,
    };
  }
}

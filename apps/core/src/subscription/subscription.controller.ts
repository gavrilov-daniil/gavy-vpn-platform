import { Controller, Get, Headers, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { SubscriptionService } from "./subscription.service.js";

// Пути ОБЯЗАНЫ совпадать с тем, что сохранено у мигрированных клиентов (migration.md P0-2):
//   /auto/<shortUuid>  — мульти-профильная подписка
//   /api/sub/<id>      — legacy базовый Авто
@Controller()
export class SubscriptionController {
  constructor(private readonly service: SubscriptionService) {}

  @Get("auto/:shortUuid")
  async auto(
    @Param("shortUuid") shortUuid: string,
    @Headers("user-agent") ua = "",
    @Res() res: Response,
  ): Promise<void> {
    const r = await this.service.deliverByShortUuid(shortUuid, ua);
    res.status(r.status).set(r.headers).send(r.body);
  }

  @Get("api/sub/:id")
  async legacy(
    @Param("id") id: string,
    @Headers("user-agent") ua = "",
    @Res() res: Response,
  ): Promise<void> {
    const r = await this.service.deliverById(id, ua);
    res.status(r.status).set(r.headers).send(r.body);
  }
}

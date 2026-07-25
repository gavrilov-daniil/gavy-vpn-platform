import { Controller, Get, Param, Post } from "@nestjs/common";
import { JobRegistry } from "./job.registry.js";
import { QueueService } from "./queue.service.js";

/**
 * Ручной прогон джоб: отладка и degraded-режим (нет Redis — расписания нет,
 * но джобы должны запускаться). Запуск СИНХРОННЫЙ: ответ содержит результат прогона.
 */
@Controller("api/admin")
export class WorkersAdminController {
  constructor(
    private readonly registry: JobRegistry,
    private readonly queue: QueueService,
  ) {}

  @Get("jobs")
  list() {
    return { degraded: this.queue.degraded, jobs: this.registry.list() };
  }

  @Post("jobs/:name/run")
  run(@Param("name") name: string) {
    return this.registry.run(name);
  }
}

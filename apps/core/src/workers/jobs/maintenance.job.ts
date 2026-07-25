import { Injectable, Logger } from "@nestjs/common";
import { AlertService } from "../alert.service.js";
import { AuthService } from "../../auth/auth.service.js";
import type { JobRunner } from "../job.types.js";

/**
 * Обслуживание: чистка таблиц, которые иначе растут вечно.
 *
 * Методы чистки были написаны, но их никто не вызывал — `job_dedup` копил бы
 * по строке на каждый алерт, а `operator_session` хранил протухшие сессии
 * бесконечно. Ни то, ни другое не ломается сразу, поэтому и не замечается.
 */
@Injectable()
export class MaintenanceJob implements JobRunner {
  readonly jobName = "maintenance" as const;
  private readonly log = new Logger(MaintenanceJob.name);

  constructor(
    private readonly alerts: AlertService,
    private readonly auth: AuthService,
  ) {}

  async run() {
    const dedupKeys = await this.alerts.sweep(7);
    const sessions = await this.auth.purgeExpired();

    if (dedupKeys > 0 || sessions > 0) {
      this.log.log(`обслуживание: удалено ключей дедупа ${dedupKeys}, протухших сессий ${sessions}`);
    }
    return { dedupKeys, sessions };
  }
}

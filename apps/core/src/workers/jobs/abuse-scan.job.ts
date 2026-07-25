import { Injectable, Logger } from "@nestjs/common";
import { AbuseService } from "../../nodes/abuse.service.js";
import { AlertService, dayBucket } from "../alert.service.js";
import type { JobRunner } from "../job.types.js";

/**
 * Детект абьюза по накопленной статистике.
 *
 * Код детекта был написан, но вызывался только вручную из админки — то есть
 * фактически не работал: никто не жмёт кнопку раз в час. Теперь по расписанию.
 *
 * Действия идемпотентны по ключу `kind:подписка:дата`, поэтому частый прогон
 * не наказывает одного и того же нарушителя повторно.
 */
@Injectable()
export class AbuseScanJob implements JobRunner {
  readonly jobName = "abuse-scan" as const;
  private readonly log = new Logger(AbuseScanJob.name);

  constructor(
    private readonly abuse: AbuseService,
    private readonly alerts: AlertService,
  ) {}

  async run() {
    const result = await this.abuse.scan();

    // приостановка подписки — событие, о котором оператор должен узнать сам,
    // а не обнаружить из жалобы клиента
    if (result.actions > 0) {
      await this.alerts.alertOnce(
        `abuse_actions:${dayBucket()}`,
        `⚠️ Анти-абьюз: сигналов ${result.signals}, применено действий ${result.actions}.\n` +
          `Разбор — в админке, раздел «Подписчики».`,
      );
      this.log.warn(`анти-абьюз: сигналов ${result.signals}, действий ${result.actions}`);
    }
    return result;
  }
}

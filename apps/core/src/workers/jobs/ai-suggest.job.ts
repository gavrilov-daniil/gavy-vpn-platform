import { Injectable, Logger } from "@nestjs/common";
import { SuggestionService } from "../../ai/suggestion.service.js";
import type { JobRunner } from "../job.types.js";

/**
 * Окно поиска. Диалог, где клиент написал давно, а подсказки так и нет, — это
 * либо выключенный провайдер, либо сбой на этом сообщении. Догонять его вечно
 * бессмысленно: оператор уже ответил руками.
 */
const LOOKBACK_MS = 30 * 60_000;
/** Потолок пачки: генерация синхронная, и один прогон не должен занимать воркер надолго. */
const BATCH = 20;

/**
 * Генерация подсказок операторам. Вынесена из HTTP-хендлера приёма сообщения
 * осознанно: клиент не должен ждать модель, а упавший провайдер не должен мешать
 * принять обращение.
 *
 * Идемпотентность — на ключе ai:<conversationId>:<messageId> (см. SuggestionService):
 * повторный прогон в том же окне не плодит подсказки.
 */
@Injectable()
export class AiSuggestJob implements JobRunner {
  readonly jobName = "ai-suggest" as const;
  private readonly log = new Logger(AiSuggestJob.name);

  constructor(private readonly suggestions: SuggestionService) {}

  async run() {
    const pending = await this.suggestions.findPending(LOOKBACK_MS, BATCH);
    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of pending) {
      const result = await this.suggestions.generate({ conversationId: item.conversationId });
      if (result.status === "created") created += 1;
      else if (result.status === "failed") failed += 1;
      else if (result.status === "skipped") skipped += 1;
    }

    if (failed > 0) this.log.warn(`подсказки: ${failed} из ${pending.length} не сгенерированы`);
    return { pending: pending.length, created, skipped, failed };
  }
}

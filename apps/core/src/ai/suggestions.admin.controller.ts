import { Body, Controller, Param, Post } from "@nestjs/common";
import { SuggestionService } from "./suggestion.service.js";

/**
 * Работа оператора с подсказкой. Отправки здесь нет: текст уходит клиенту
 * существующим путём — POST /api/admin/support/conversations/:id/reply
 * с полем suggestionId, который и переводит подсказку в статус sent.
 */
@Controller("api/admin/support")
export class SuggestionsAdminController {
  constructor(private readonly suggestions: SuggestionService) {}

  /**
   * Ручная генерация. Штатно подсказка появляется сама (джоба ai-suggest),
   * кнопка нужна, когда провайдер лежал или был выключен в момент обращения.
   */
  @Post("conversations/:id/suggest")
  generate(@Param("id") id: string) {
    return this.suggestions.generate({ conversationId: id, force: true });
  }

  @Post("suggestions/:id/accept")
  accept(@Param("id") id: string, @Body() body: { text?: string }) {
    return this.suggestions.accept(id, body?.text);
  }

  @Post("suggestions/:id/reject")
  reject(@Param("id") id: string) {
    return this.suggestions.reject(id);
  }
}

import { Module } from "@nestjs/common";
import { AiProviderService } from "./ai-provider.service.js";
import { AiProvidersAdminController } from "./ai.admin.controller.js";
import { KbAdminController } from "./kb.admin.controller.js";
import { KbService } from "./kb.service.js";
import { SuggestionService } from "./suggestion.service.js";
import { SuggestionsAdminController } from "./suggestions.admin.controller.js";

/**
 * Контур ИИ-подсказок. Ничего, кроме БД, не импортирует: и джоба (WorkersModule),
 * и экран поддержки (SupportModule) зависят от него, а не наоборот — иначе
 * SupportModule не смог бы дотянуться до очереди.
 */
@Module({
  controllers: [AiProvidersAdminController, KbAdminController, SuggestionsAdminController],
  providers: [AiProviderService, KbService, SuggestionService],
  exports: [AiProviderService, KbService, SuggestionService],
})
export class AiModule {}

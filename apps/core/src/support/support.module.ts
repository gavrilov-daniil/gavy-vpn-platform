import { Module } from "@nestjs/common";
import { AiModule } from "../ai/ai.module.js";
import { BotModule } from "../bot/bot.module.js";
import { WorkersModule } from "../workers/workers.module.js";
import { SupportController } from "./support.controller.js";
import { SupportService } from "./support.service.js";

// WorkersModule нужен ради очереди: подсказка ставится джобой сразу при приёме
// сообщения. Цикла нет — WorkersModule зависит от AiModule, а не от поддержки.
@Module({
  imports: [BotModule, AiModule, WorkersModule],
  controllers: [SupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}

import { Module } from "@nestjs/common";
import { BotClient } from "./bot.client.js";

@Module({
  providers: [BotClient],
  exports: [BotClient],
})
export class BotModule {}

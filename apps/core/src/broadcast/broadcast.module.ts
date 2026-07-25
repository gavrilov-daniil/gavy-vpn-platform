import { Module } from "@nestjs/common";
import { BotModule } from "../bot/bot.module.js";
import { BroadcastAdminController } from "./broadcast.admin.controller.js";
import { BroadcastService } from "./broadcast.service.js";
import { DispatchService } from "./dispatch.service.js";
import { SegmentService } from "./segment.service.js";
import { TouchpointService } from "./touchpoint.service.js";

@Module({
  imports: [BotModule],
  controllers: [BroadcastAdminController],
  providers: [SegmentService, DispatchService, BroadcastService, TouchpointService],
  exports: [SegmentService, DispatchService, BroadcastService, TouchpointService],
})
export class BroadcastModule {}

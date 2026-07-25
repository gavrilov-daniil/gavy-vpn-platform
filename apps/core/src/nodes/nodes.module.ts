import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller.js";
import { NodesAdminController } from "./nodes.admin.controller.js";
import { NodeStateService } from "./node-state.service.js";
import { CascadeService } from "./cascade.service.js";
import { StatsService } from "./stats.service.js";
import { AbuseService } from "./abuse.service.js";

@Module({
  controllers: [AgentController, NodesAdminController],
  providers: [NodeStateService, CascadeService, StatsService, AbuseService],
  exports: [NodeStateService, CascadeService, StatsService, AbuseService],
})
export class NodesModule {}

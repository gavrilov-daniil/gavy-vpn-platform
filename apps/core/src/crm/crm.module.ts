import { Module } from "@nestjs/common";
import { AttributionService } from "./attribution.service.js";
import { CampaignService } from "./campaign.service.js";
import { CampaignsAdminController } from "./campaigns.admin.controller.js";
import { CrmInternalController } from "./crm.internal.controller.js";
import { EventsService } from "./events.service.js";

@Module({
  controllers: [CampaignsAdminController, CrmInternalController],
  providers: [EventsService, AttributionService, CampaignService],
  exports: [EventsService, AttributionService],
})
export class CrmModule {}

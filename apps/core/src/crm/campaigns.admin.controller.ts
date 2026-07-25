import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { CampaignService } from "./campaign.service.js";
import { EventsService } from "./events.service.js";

@Controller("api/admin")
export class CampaignsAdminController {
  constructor(
    private readonly campaigns: CampaignService,
    private readonly events: EventsService,
  ) {}

  @Get("campaigns")
  list() {
    return this.campaigns.list();
  }

  @Post("campaigns")
  create(@Body() body: { slug: string; name: string; channel?: string; costKopeks?: number }) {
    if (!body.slug || !body.name) throw new BadRequestException("нужны slug и name");
    return this.campaigns.create(body);
  }

  @Patch("campaigns/:id")
  update(
    @Param("id") id: string,
    @Body() body: { name?: string; channel?: string; status?: string; costKopeks?: number },
  ) {
    return this.campaigns.update(id, body);
  }

  @Post("campaigns/:id/links")
  createLink(@Param("id") id: string, @Body() body: { label?: string }) {
    return this.campaigns.createLink(id, body?.label);
  }

  @Get("campaigns/:id/stats")
  stats(@Param("id") id: string) {
    return this.campaigns.stats(id);
  }

  @Get("funnel")
  funnel(@Query("days") days?: string) {
    return this.events.funnel(days ? Number(days) : undefined);
  }
}

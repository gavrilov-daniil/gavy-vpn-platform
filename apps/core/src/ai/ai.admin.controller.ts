import { BadRequestException, Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { AiProviderService } from "./ai-provider.service.js";
import { AI_PROVIDER_SPECS } from "./adapters/registry.js";

/** Подключение провайдера ИИ из админки: ключ, модель, лимиты, тумблер, проверка. */
@Controller("api/admin/ai/providers")
export class AiProvidersAdminController {
  constructor(private readonly providers: AiProviderService) {}

  @Get()
  list() {
    return this.providers.listForAdmin();
  }

  @Get("specs")
  specs() {
    return AI_PROVIDER_SPECS;
  }

  @Post()
  create(
    @Body()
    body: {
      provider: string;
      alias: string;
      model?: string;
      credentials?: Record<string, string>;
      settings?: Record<string, unknown>;
    },
  ) {
    if (!body.alias?.trim()) throw new BadRequestException("нужен алиас");
    return this.providers.create(body);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body()
    body: {
      alias?: string;
      model?: string;
      isEnabled?: boolean;
      credentials?: Record<string, string>;
      settings?: Record<string, unknown>;
    },
  ) {
    return this.providers.update(id, body);
  }

  @Post(":id/check")
  check(@Param("id") id: string) {
    return this.providers.healthCheck(id);
  }
}

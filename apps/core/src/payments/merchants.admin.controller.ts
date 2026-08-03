import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { PROVIDER_SPECS } from "@corelink/payments";
import { MinRole } from "../auth/roles.js";
import { MerchantService } from "./merchant.service.js";

/**
 * Управление мерчантами из админки: подключить, настроить ключи, включить, проверить.
 *
 * Единственный раздел под superadmin: здесь лежат ключи, которыми принимаются деньги,
 * и подменивший их получает выручку себе. Список провайдеров закрыт вместе с остальным —
 * он подсказывает, какие ключи вообще есть смысл искать.
 */
@MinRole("superadmin")
@Controller("api/admin/merchants")
export class MerchantsAdminController {
  constructor(private readonly merchants: MerchantService) {}

  @Get()
  list() {
    return this.merchants.listForAdmin();
  }

  @Get("provider-specs")
  specs() {
    return PROVIDER_SPECS;
  }

  @Post()
  create(
    @Body()
    body: {
      provider: string;
      alias: string;
      title?: string;
      mode?: "live" | "test";
      credentials?: Record<string, string>;
      settings?: Record<string, unknown>;
      purposes?: string[];
    },
  ) {
    return this.merchants.create(body);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body()
    body: {
      alias?: string;
      title?: string;
      isEnabled?: boolean;
      mode?: "live" | "test";
      priority?: number;
      purposes?: string[];
      settings?: Record<string, unknown>;
      credentials?: Record<string, string>;
    },
  ) {
    return this.merchants.update(id, body);
  }

  @Post(":id/check")
  check(@Param("id") id: string) {
    return this.merchants.healthCheck(id);
  }
}

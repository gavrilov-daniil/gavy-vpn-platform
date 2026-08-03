import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { KbService } from "./kb.service.js";

/**
 * База знаний. Удаления нет осознанно: выключенный документ не участвует в поиске,
 * но остаётся читаемым по ссылкам retrieved_doc_ids уже выданных подсказок.
 */
@Controller("api/admin/support/kb")
export class KbAdminController {
  constructor(private readonly kb: KbService) {}

  @Get()
  list() {
    return this.kb.list();
  }

  /** Проверка поиска глазами оператора: что именно уедет в модель по такому вопросу. */
  @Get("search")
  search(@Query("q") q?: string) {
    if (!q?.trim()) throw new BadRequestException("нужен параметр q");
    return this.kb.search(q);
  }

  @Post()
  create(@Body() body: { title: string; body: string; source?: string; lang?: string }) {
    if (!body.title?.trim() || !body.body?.trim()) throw new BadRequestException("нужны title и body");
    return this.kb.create(body);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() body: { title?: string; body?: string; source?: string | null; lang?: string; isActive?: boolean },
  ) {
    return this.kb.update(id, body);
  }
}

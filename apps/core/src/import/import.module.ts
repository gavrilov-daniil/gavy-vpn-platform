import { Body, Controller, Module, Post } from "@nestjs/common";
import { RemnawaveImportService } from "./remnawave-import.service.js";

@Controller("api/admin/import")
class ImportAdminController {
  constructor(private readonly importer: RemnawaveImportService) {}

  /**
   * Перенос с действующей панели. По умолчанию dry-run: показывает, что будет
   * сделано, ничего не записывая. Реальный импорт — только с `{"apply": true}`.
   */
  @Post("remnawave")
  run(@Body() body: { apply?: boolean; withDevices?: boolean }) {
    return this.importer.run({ dryRun: body?.apply !== true, withDevices: body?.withDevices });
  }
}

@Module({
  controllers: [ImportAdminController],
  providers: [RemnawaveImportService],
  exports: [RemnawaveImportService],
})
export class ImportModule {}

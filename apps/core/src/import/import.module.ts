import { Body, Controller, Module, Post } from "@nestjs/common";
import { NodesModule } from "../nodes/nodes.module.js";
import { InfraImportService } from "./infra-import.service.js";
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
  // InfraService со всей его валидацией и пересборкой desired-state живёт в NodesModule:
  // импортёр обязан писать в сеть тем же путём, что и админка, иначе появится вторая
  // модель того, что такое корректный inbound
  imports: [NodesModule],
  controllers: [ImportAdminController],
  providers: [RemnawaveImportService, InfraImportService],
  exports: [RemnawaveImportService],
})
export class ImportModule {}

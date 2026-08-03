import { Global, Module } from "@nestjs/common";
import { createDb, type Database } from "@corelink/db";

export const DB = Symbol("DB");

// Явный singleton-провайдер Drizzle-клиента. Без «магии» — один инстанс на процесс.
@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: (): Database => createDb(),
    },
  ],
  exports: [DB],
})
export class DbModule {}

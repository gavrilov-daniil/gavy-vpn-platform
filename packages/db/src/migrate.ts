import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Раннер миграций для прода. Через drizzle-kit это не работает: он devDependency,
// и в образе, собранном `pnpm deploy --prod`, его нет. drizzle-orm — обычная
// зависимость, а его migrator читает тот же _journal.json, что и drizzle-kit.

// Путь считаем от собранного файла (dist/migrate.js → ../drizzle), а не от cwd:
// каталог запуска в контейнере не совпадает с корнем пакета.
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // Журнал читаем сами, чтобы напечатать ожидаемое число миграций: drizzle молча
  // пропускает те, чей `when` не больше последнего применённого, и при этом рапортует
  // об успехе. Расхождение «в журнале N, в базе M» — единственный доступный сигнал.
  const journal = JSON.parse(
    readFileSync(resolve(migrationsFolder, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };

  const client = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });

    const applied = await client<Array<{ count: string }>>`
      select count(*)::text as count from drizzle.__drizzle_migrations
    `;
    const inDb = Number(applied[0]?.count ?? 0);

    console.log(`migrations: journal=${journal.entries.length} applied=${inDb}`);
    if (inDb < journal.entries.length) {
      throw new Error(
        `applied ${inDb} of ${journal.entries.length} migrations — drizzle skipped some (see packages/db/drizzle/meta/README.md)`,
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Database = ReturnType<typeof createDb>;

/** Пул на процесс. Для api и worker десяти соединений хватает, для тестов — многовато. */
const DEFAULT_POOL_MAX = 10;

/**
 * `poolMax` задаётся там, где процессов много, а работы в каждом мало: тесты
 * запускают файл своим процессом и гоняются пачками (node --test × turbo по
 * пакетам), и десять соединений на каждый упираются в max_connections сервера —
 * лишние коннекты отбиваются, а тест падает на пустом месте.
 */
export function createDb(url = process.env.DATABASE_URL, poolMax = DEFAULT_POOL_MAX) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: poolMax });
  return drizzle(client, { schema });
}

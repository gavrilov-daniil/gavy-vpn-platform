import type { Request } from "express";

/**
 * Путь запроса в том виде, в котором его сравнивают гварды.
 *
 * Express матчит роуты БЕЗ учёта регистра (`/INTERNAL/...` попадает в тот же хендлер,
 * что и `/internal/...`), поэтому гвард, сравнивающий префикс как есть, обходится сменой
 * регистра. Приводим к нижнему регистру и отрезаем query.
 */
export function normalizedPath(req: Request): string {
  const raw = req.path ?? req.url ?? "";
  const [pathname] = raw.split("?");
  return pathname.toLowerCase();
}

/** Путь лежит под префиксом: сам префикс без слеша тоже считается (роут `/api/admin`). */
export function isUnderPrefix(path: string, prefix: string): boolean {
  const normalized = prefix.replace(/\/+$/, "");
  return path === normalized || path.startsWith(`${normalized}/`);
}

/** Значение заголовка строкой: express отдаёт string | string[] | undefined. */
export function headerValue(req: Request, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

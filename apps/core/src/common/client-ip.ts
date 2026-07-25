import type { Request } from "express";
import { headerValue } from "./request-path.js";

/**
 * Адрес клиента для лимитов на публичных эндпоинтах.
 *
 * `trustProxy=true` — берём левый хоп `x-forwarded-for`. За реверс-прокси это
 * единственный способ различить клиентов: socket-адрес там один на всех, и лимит
 * по IP превратился бы в глобальный счётчик, режущий всю базу разом.
 * `trustProxy=false` — только socket-адрес: если core смотрит в интернет напрямую,
 * заголовок подделывается и лимит по IP обходится одной строкой.
 */
export function clientIp(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const first = headerValue(req, "x-forwarded-for").split(",")[0]?.trim();
    if (first) return normalize(first);
  }
  return normalize(req.socket?.remoteAddress ?? req.ip ?? "");
}

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) и IPv4 без обёртки — это один и тот же клиент. */
function normalize(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "unknown";
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

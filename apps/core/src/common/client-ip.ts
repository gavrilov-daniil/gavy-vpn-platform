import type { Request } from "express";
import { headerValue } from "./request-path.js";

/**
 * Адрес клиента для лимитов на публичных эндпоинтах.
 *
 * `trustProxy=true` — берём ПРАВЫЙ хоп `x-forwarded-for`. За реверс-прокси это
 * единственный способ различить клиентов: socket-адрес там один на всех, и лимит
 * по IP превратился бы в глобальный счётчик, режущий всю базу разом.
 *
 * Почему правый, а не левый. Прокси не заменяет заголовок, а ДОПИСЫВАЕТ в него
 * адрес своего пира. Значит правый хоп — единственный, который поставили мы сами;
 * всё левее него прислал клиент и полностью им контролируется. С левым хопом
 * клиент подставлял произвольный `x-forwarded-for` и получал новый ключ лимита на
 * каждый запрос: не работали ни `admin-login:ip`, ни `sub:ip`, ни остальные.
 *
 * Отсюда инвариант деплоя: перед core стоит РОВНО ОДИН доверенный прокси. Два
 * прокси сдвинут нужный хоп на позицию левее, и лимит начнёт считать по адресу
 * внутреннего прокси — то есть склеит всех клиентов в один счётчик.
 *
 * `trustProxy=false` — только socket-адрес: если core смотрит в интернет напрямую,
 * заголовок подделывается и лимит по IP обходится одной строкой.
 */
export function clientIp(req: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const hops = headerValue(req, "x-forwarded-for").split(",");
    const nearest = hops[hops.length - 1]?.trim();
    if (nearest) return normalize(nearest);
  }
  return normalize(req.socket?.remoteAddress ?? req.ip ?? "");
}

/** IPv4-mapped IPv6 (`::ffff:1.2.3.4`) и IPv4 без обёртки — это один и тот же клиент. */
function normalize(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "unknown";
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

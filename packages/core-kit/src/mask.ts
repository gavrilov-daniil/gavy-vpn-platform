const SECRET_HEADERS = new Set([
  "authorization",
  "crypto-pay-api-token",
  "merchant_api_key",
  "x-signature",
  "x-service-token",
  "x-telegram-bot-api-secret-token",
  "hmac",
  "cookie",
]);

const SECRET_FIELD = /token|secret|key|password|signature|credential|api_key/i;

// Telegram-токен утекает через URL (api.telegram.org/bot<TOKEN>/method) — вырезаем отдельно.
const TELEGRAM_TOKEN_IN_URL = /\/bot\d+:[A-Za-z0-9_-]+/g;

export function maskValue(value: string): string {
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

export function maskUrl(url: string): string {
  return url.replace(TELEGRAM_TOKEN_IN_URL, "/bot***");
}

export function maskHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? maskValue(v) : v;
  }
  return out;
}

/** Рекурсивно маскирует поля, похожие на секреты. Для аудита в external_api_log. */
export function maskBody(body: unknown, depth = 0): unknown {
  if (depth > 6 || body === null || body === undefined) return body;
  if (typeof body === "string") return maskUrl(body);
  if (Array.isArray(body)) return body.map((v) => maskBody(v, depth + 1));
  if (typeof body === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = SECRET_FIELD.test(k) && typeof v === "string" ? maskValue(v) : maskBody(v, depth + 1);
    }
    return out;
  }
  return body;
}

import type { AiProviderConfig, AiProviderId } from "./adapters/types.js";

/** Базовые адреса провайдеров — константы кода, а не настройка из тела PATCH-а. */
export const AI_BASE_URLS: Record<AiProviderId, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai_compatible: "https://api.openai.com/v1",
};

/**
 * Переопределение адреса — та же дыра, что была у мерчантов: подменённый хост уводит
 * расшифрованный ключ на чужой сервер. Поэтому правила разные и осознанно:
 *
 *  - anthropic: только официальный хост. Провайдер один, поводов ходить мимо нет;
 *  - openai_compatible: любой https-хост. Смысл этого адаптера ровно в том, чтобы
 *    ходить через прокси (litellm, openrouter, свой шлюз), и allowlist его убивает.
 *
 * Для обоих: http разрешён только на loopback (свой vllm/ollama на этой же машине) —
 * туда трафик не выходит с хоста. Логин/пароль в URL запрещены: они уезжают
 * в Authorization чужого прокси.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isAllowedAiApiUrl(provider: string, rawUrl: unknown): boolean {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return false;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.username.length > 0 || url.password.length > 0) return false;

  const host = url.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) return false;

  if (provider === "anthropic") return host === "api.anthropic.com" || isLoopback;
  if (provider === "openai_compatible") return true;
  return false;
}

export function resolveAiBaseUrl(config: AiProviderConfig): string {
  const base = AI_BASE_URLS[config.provider];
  const override = config.settings.api_url;
  if (override === undefined || override === null || override === "") return trimTrailingSlash(base);
  if (isAllowedAiApiUrl(config.provider, override)) return trimTrailingSlash(String(override));
  return trimTrailingSlash(base);
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

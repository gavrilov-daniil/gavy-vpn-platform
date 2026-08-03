export const AI_PROVIDER_IDS = ["anthropic", "openai_compatible"] as const;

export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

/** Конфигурация провайдера из БД (креды уже расшифрованы вызывающим). */
export interface AiProviderConfig {
  id: string;
  provider: AiProviderId;
  alias: string;
  model: string;
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
}

export interface AiCompletionInput {
  system: string;
  /** Готовый пользовательский ход: переписка и документы уже собраны и почищены. */
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
  correlationId: string;
}

export interface AiCompletion {
  text: string;
  /** Что реально ответило: провайдер может подставить свой алиас модели. */
  model: string;
}

export class AiAdapterError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "AiAdapterError";
  }
}

/**
 * Провайдер ИИ. Две реализации (Anthropic и OpenAI-совместимая) существуют не для
 * симметрии: у них разные адреса, заголовки и форма ответа, и абстракция, проверенная
 * ровно одной реализацией, при добавлении второй обычно переписывается целиком.
 */
export interface AiAdapter {
  readonly provider: AiProviderId;
  readonly defaultModel: string;
  /** Хватает ли кредов. Провайдер без ключа не роняет старт, а не даёт сгенерировать подсказку. */
  isConfigured(config: AiProviderConfig): boolean;
  complete(config: AiProviderConfig, input: AiCompletionInput): Promise<AiCompletion>;
  /** Кнопка «Проверить» в админке: дешёвый вызов, который упрётся в неверный ключ. */
  healthCheck(config: AiProviderConfig): Promise<{ ok: boolean; detail?: string }>;
}

export function requireCredential(config: AiProviderConfig, key: string): string {
  const value = config.credentials[key];
  if (!value) throw new AiAdapterError(`${config.provider}: не задан ключ ${key}`, "AI_NOT_CONFIGURED");
  return value;
}

export interface AiProviderSpec {
  provider: AiProviderId;
  title: string;
  defaultModel: string;
  credentialFields: Array<{ key: string; label: string; required: boolean }>;
  settingFields: Array<{ key: string; label: string; type: "number" | "string"; default?: string | number }>;
}

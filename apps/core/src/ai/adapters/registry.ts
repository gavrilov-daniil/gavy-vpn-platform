import { anthropicAdapter } from "./anthropic.js";
import { openAiCompatibleAdapter } from "./openai.js";
import { AiAdapterError, type AiAdapter, type AiProviderId, type AiProviderSpec } from "./types.js";

const ADAPTERS: Record<AiProviderId, AiAdapter> = {
  anthropic: anthropicAdapter,
  openai_compatible: openAiCompatibleAdapter,
};

export function getAiAdapter(provider: string): AiAdapter {
  const adapter = ADAPTERS[provider as AiProviderId];
  if (!adapter) throw new AiAdapterError(`неизвестный провайдер ИИ: ${provider}`, "AI_UNKNOWN_PROVIDER");
  return adapter;
}

/** Админка рисует форму по спецификации, а не по хардкоду в экране. */
export const AI_PROVIDER_SPECS: AiProviderSpec[] = [
  {
    provider: "anthropic",
    title: "Anthropic (Claude)",
    defaultModel: anthropicAdapter.defaultModel,
    credentialFields: [{ key: "api_key", label: "API key", required: true }],
    settingFields: [
      { key: "max_context_chars", label: "Лимит контекста, символов", type: "number", default: 12000 },
      { key: "max_output_tokens", label: "Лимит ответа, токенов", type: "number", default: 700 },
      { key: "max_per_conversation", label: "Подсказок на диалог", type: "number", default: 20 },
      { key: "max_per_day", label: "Подсказок в сутки на орг", type: "number", default: 300 },
    ],
  },
  {
    provider: "openai_compatible",
    title: "OpenAI-совместимый (прокси, локальная модель)",
    defaultModel: openAiCompatibleAdapter.defaultModel,
    credentialFields: [{ key: "api_key", label: "API key", required: true }],
    settingFields: [
      { key: "api_url", label: "Адрес API (https или loopback)", type: "string" },
      { key: "max_context_chars", label: "Лимит контекста, символов", type: "number", default: 12000 },
      { key: "max_output_tokens", label: "Лимит ответа, токенов", type: "number", default: 700 },
      { key: "max_per_conversation", label: "Подсказок на диалог", type: "number", default: 20 },
      { key: "max_per_day", label: "Подсказок в сутки на орг", type: "number", default: 300 },
    ],
  },
];

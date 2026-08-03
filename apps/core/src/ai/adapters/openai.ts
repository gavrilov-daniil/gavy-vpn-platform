import { request } from "@corelink/core-kit";
import { resolveAiBaseUrl } from "../provider-urls.js";
import {
  AiAdapterError,
  requireCredential,
  type AiAdapter,
  type AiCompletion,
  type AiCompletionInput,
  type AiProviderConfig,
} from "./types.js";

interface OpenAiResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  error?: { message?: string };
}

/**
 * OpenAI-совместимый провайдер: сам OpenAI, но чаще прокси (litellm, openrouter,
 * свой шлюз) или локальная модель. Отличается от Anthropic адресом, заголовком
 * авторизации и формой ответа — ровно то, ради чего интерфейс и заведён.
 */
export const openAiCompatibleAdapter: AiAdapter = {
  provider: "openai_compatible",
  defaultModel: "gpt-4o-mini",

  isConfigured(config) {
    return Boolean(config.credentials.api_key);
  },

  async complete(config: AiProviderConfig, input: AiCompletionInput): Promise<AiCompletion> {
    const res = await request<OpenAiResponse>(`${resolveAiBaseUrl(config)}/chat/completions`, {
      method: "POST",
      provider: "ai:openai_compatible",
      correlationId: input.correlationId,
      timeoutMs: input.timeoutMs,
      retries: 1,
      headers: { authorization: `Bearer ${requireCredential(config, "api_key")}` },
      json: {
        model: config.model,
        max_tokens: input.maxTokens,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
      },
    });

    const body = res.body;
    const text = (body?.choices?.[0]?.message?.content ?? "").trim();
    if (!text) {
      throw new AiAdapterError(`openai: пустой ответ (${body?.error?.message ?? "no content"})`, "AI_EMPTY");
    }
    return { text, model: body?.model ?? config.model };
  },

  async healthCheck(config) {
    try {
      const res = await this.complete(config, {
        system: "Отвечай одним словом.",
        prompt: "Ответь словом «ок».",
        maxTokens: 16,
        timeoutMs: 15_000,
        correlationId: `ai-health-${config.id}`,
      });
      return { ok: true, detail: `${res.model}: ${res.text.slice(0, 60)}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
};

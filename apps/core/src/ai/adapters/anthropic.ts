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

const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicResponse {
  model?: string;
  stop_reason?: string;
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

export const anthropicAdapter: AiAdapter = {
  provider: "anthropic",
  defaultModel: "claude-sonnet-5",

  isConfigured(config) {
    return Boolean(config.credentials.api_key);
  },

  async complete(config: AiProviderConfig, input: AiCompletionInput): Promise<AiCompletion> {
    const res = await request<AnthropicResponse>(`${resolveAiBaseUrl(config)}/messages`, {
      method: "POST",
      provider: "ai:anthropic",
      correlationId: input.correlationId,
      timeoutMs: input.timeoutMs,
      // Лишние повторы тут стоят денег и времени оператора: подсказка нужна сейчас
      // или не нужна вовсе. Один retry закрывает 429/5xx, дальше работаем без неё.
      retries: 1,
      headers: {
        "x-api-key": requireCredential(config, "api_key"),
        "anthropic-version": ANTHROPIC_VERSION,
      },
      json: {
        model: config.model,
        max_tokens: input.maxTokens,
        system: input.system,
        // max_tokens ограничивает размышления ВМЕСТЕ с текстом ответа, а на новых
        // моделях размышления включены по умолчанию: с ними короткая подсказка
        // обрывалась бы на середине. Оператору нужен текст, а не рассуждения.
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: input.prompt }],
      },
    });

    const body = res.body;
    // Классификаторы отвечают 200 с stop_reason=refusal и пустым content:
    // чтение content[0] без этой ветки падало бы на ровном месте.
    if (body?.stop_reason === "refusal") {
      throw new AiAdapterError("модель отклонила запрос", "AI_REFUSAL");
    }

    const text = (body?.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("")
      .trim();

    if (!text) throw new AiAdapterError(`anthropic: пустой ответ (${body?.error?.message ?? "no text"})`, "AI_EMPTY");
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

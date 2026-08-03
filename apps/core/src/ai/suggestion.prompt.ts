export interface PromptMessage {
  senderType: string;
  content: string;
}

export interface PromptDocument {
  id: string;
  title: string;
  body: string;
}

export interface BuildPromptInput {
  messages: PromptMessage[];
  documents: PromptDocument[];
  maxContextChars: number;
  /**
   * Точные секреты этого клиента (vless_uuid, short_uuid, ссылка подписки).
   * Вырезаются дословно — общие шаблоны ниже ловят не всё.
   */
  secrets?: string[];
}

export const SUGGESTION_SYSTEM_PROMPT = [
  "Ты помогаешь оператору поддержки VPN-сервиса. Ты пишешь ЧЕРНОВИК ответа клиенту:",
  "его прочитает оператор, при необходимости поправит и отправит сам. Клиенту ты не пишешь.",
  "",
  "Правила:",
  "1. Опирайся только на выдержки из базы знаний и на саму переписку.",
  "2. Не выдумывай факты о тарифах, ценах, сроках, лимитах и доступах.",
  "   Если точной цифры или условия нет в базе знаний — не называй их.",
  "3. Если ответа в базе знаний нет или данных не хватает — так и напиши:",
  "   короткий ответ с предложением передать вопрос оператору, который уточнит детали.",
  "4. Не проси у клиента ключи, токены, ссылку подписки и пароли и не выводи их сам.",
  "5. Пиши по-русски, на «вы», без приветственных шаблонов и подписей — 2–5 предложений.",
  "6. Отдавай только текст ответа, без пояснений о том, как ты его составил.",
].join("\n");

const SENDER_LABELS: Record<string, string> = {
  contact: "Клиент",
  operator: "Оператор",
  ai: "Подсказка ИИ",
  system: "Система",
};

/** Ссылки клиентских протоколов целиком: внутри и uuid, и Reality-ключи. */
const CLIENT_LINK = /\b(?:vless|vmess|trojan|ss|ssr|hy2|hysteria2?|tuic):\/\/\S+/gi;
/** Ссылка подписки: любой http(s)-URL с длинным токеном в пути или запросе. */
const LINK_WITH_TOKEN = /\bhttps?:\/\/\S*[A-Za-z0-9_-]{16,}\S*/g;
/**
 * key=value и "key": "value" для полей, которые по имени являются секретом.
 * Кавычка допускается и перед разделителем: в JSON она стоит между именем и двоеточием.
 */
const SECRET_FIELD =
  /\b(token|secret|password|pass|api[_-]?key|key|pbk|sid|public[_-]?key|private[_-]?key|uuid)\b("?\s*[:=]\s*"?)([^\s",;]+)/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** short_uuid подписки — 24 hex; заодно ловит хеши и сырые ключи. */
const LONG_HEX = /\b[0-9a-f]{24,}\b/gi;
/** Reality pbk и прочие base64url-ключи: 40+ символов алфавита без пробелов. */
const LONG_TOKEN = /\b[A-Za-z0-9_-]{40,}\b/g;

const MASK = "[скрыто]";

/**
 * Вычищает из текста всё, что не должно уехать в модель: ссылки подписки,
 * vless-ссылки, uuid, ключи Reality, токены и пароли.
 *
 * Двухслойно: сначала точные секреты этого клиента из БД, потом общие шаблоны —
 * шаблон не знает, что «a1b2…» это его short_uuid, а точный список не знает,
 * что клиент вставил в чат чужой ключ.
 */
export function redactSecrets(text: string, secrets: string[] = []): string {
  let out = text;

  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join(MASK);
  }

  out = out.replace(CLIENT_LINK, MASK);
  out = out.replace(LINK_WITH_TOKEN, MASK);
  out = out.replace(SECRET_FIELD, (_full, field: string, sep: string) => `${field}${sep}${MASK}`);
  out = out.replace(UUID, MASK);
  out = out.replace(LONG_HEX, MASK);
  out = out.replace(LONG_TOKEN, MASK);
  return out;
}

/**
 * Промпт под лимит символов. Документы получают не больше 60% бюджета: без этого
 * одна длинная статья вытесняла бы саму переписку, и модель отвечала бы не на вопрос.
 * Сообщения берутся с конца — актуальные важнее первых.
 */
export function buildSuggestionPrompt(input: BuildPromptInput): { prompt: string; documentIds: string[] } {
  const budget = Math.max(input.maxContextChars, 500);
  const secrets = input.secrets ?? [];

  const documentIds: string[] = [];
  const documentBlocks: string[] = [];
  let documentsBudget = Math.floor(budget * 0.6);
  for (const doc of input.documents) {
    const body = redactSecrets(doc.body, secrets).trim();
    const header = `### ${redactSecrets(doc.title, secrets).trim()}\n`;
    const room = documentsBudget - header.length;
    if (room < 200) break;
    const block = header + (body.length > room ? `${body.slice(0, room)}…` : body);
    documentBlocks.push(block);
    documentIds.push(doc.id);
    documentsBudget -= block.length;
  }

  let messagesBudget = budget - documentBlocks.reduce((sum, b) => sum + b.length, 0);
  const messageBlocks: string[] = [];
  for (let i = input.messages.length - 1; i >= 0; i -= 1) {
    const message = input.messages[i];
    const label = SENDER_LABELS[message.senderType] ?? message.senderType;
    const text = redactSecrets(message.content, secrets).trim();
    const block = `${label}: ${text}`;
    // Последнее сообщение обрезаем, но не выбрасываем: без него отвечать не на что.
    if (block.length > messagesBudget) {
      if (messageBlocks.length === 0) messageBlocks.push(block.slice(0, Math.max(messagesBudget, 200)));
      break;
    }
    messageBlocks.push(block);
    messagesBudget -= block.length;
  }
  messageBlocks.reverse();

  const parts = [
    documentBlocks.length > 0
      ? `Выдержки из базы знаний:\n\n${documentBlocks.join("\n\n")}`
      : "Выдержки из базы знаний: ничего подходящего не нашлось.",
    `Переписка:\n\n${messageBlocks.join("\n")}`,
    "Составь черновик ответа на последнее сообщение клиента.",
  ];

  return { prompt: parts.join("\n\n"), documentIds };
}

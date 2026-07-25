export interface BotConfig {
  port: number;
  botToken: string;
  /** Пустой → long polling (локальная разработка). Заданный → webhook. */
  webhookUrl: string;
  webhookSecret: string;
  coreApiUrl: string;
  /** Общий секрет для входящих вызовов core → бот и исходящих бот → core. */
  serviceToken: string;
  adminBotToken: string;
  adminChatId: string;
  topupAmountsKopeks: number[];
  happInstallUrl: string;
}

export function loadConfig(): BotConfig {
  const botToken = process.env.BOT_TOKEN ?? "";
  if (!botToken) throw new Error("BOT_TOKEN не задан");

  const webhookUrl = (process.env.BOT_WEBHOOK_URL ?? "").replace(/\/+$/, "");
  const webhookSecret = process.env.BOT_WEBHOOK_SECRET ?? "";
  // Вебхук без секрета — открытый POST /tg: кто угодно подделает апдейт от чужого tgId.
  if (webhookUrl && !webhookSecret) {
    throw new Error("BOT_WEBHOOK_SECRET обязателен при заданном BOT_WEBHOOK_URL");
  }

  return {
    port: Number(process.env.BOT_PORT ?? 3300),
    botToken,
    webhookUrl,
    webhookSecret,
    coreApiUrl: (process.env.CORE_API_URL ?? "http://localhost:3100").replace(/\/+$/, ""),
    serviceToken: process.env.SERVICE_TOKEN ?? "",
    adminBotToken: process.env.ADMIN_BOT_TOKEN ?? "",
    adminChatId: process.env.ADMIN_CHAT_ID ?? "",
    topupAmountsKopeks: parseAmounts(process.env.BOT_TOPUP_AMOUNTS ?? "500,1000,2500,5000"),
    happInstallUrl: process.env.BOT_HAPP_INSTALL_URL ?? "https://happ.su/",
  };
}

/** Суммы задаются в рублях, внутри везде копейки. */
function parseAmounts(raw: string): number[] {
  const amounts = raw
    .split(",")
    .map((v) => Math.round(Number(v.trim()) * 100))
    .filter((n) => Number.isFinite(n) && n > 0);
  return amounts.length > 0 ? amounts : [50_000, 100_000, 250_000, 500_000];
}

export interface CoreConfig {
  instanceType: "api" | "worker";
  port: number;
  defaultOrgId: string;
  subPublicHost: string;
  profileUpdateIntervalHours: number;
  supportUrl: string;
  announce: string;
  /** Ключ шифрования кредов мерчантов. В БД креды лежат только зашифрованными. */
  secretsMasterKey: string;
  /** Внешний URL API — из него строятся callback_url для платёжных вебхуков. */
  publicApiUrl: string;
  paymentSuccessUrl: string;
  paymentFailUrl: string;
  /** Внутренний URL бота — через него уходят рассылки и ответы поддержки в Telegram. */
  botInternalUrl: string;
  /** Общий секрет core↔бот, заголовок x-service-token. */
  serviceToken: string;
  /** Секрет node-agent↔core, заголовок x-agent-token. */
  agentToken: string;
}

export function loadConfig(): CoreConfig {
  return {
    instanceType: (process.env.INSTANCE_TYPE as "api" | "worker") ?? "api",
    port: Number(process.env.CORE_PORT ?? 3100),
    defaultOrgId: process.env.DEFAULT_ORG_ID ?? "00000000-0000-0000-0000-000000000001",
    subPublicHost: process.env.SUB_PUBLIC_HOST ?? "panel.gavy.shop",
    profileUpdateIntervalHours: Number(process.env.SUB_PROFILE_UPDATE_INTERVAL ?? 12),
    supportUrl: process.env.SUB_SUPPORT_URL ?? "",
    announce: process.env.SUB_ANNOUNCE ?? "",
    secretsMasterKey: process.env.SECRETS_MASTER_KEY ?? "dev-master-key-change-me",
    publicApiUrl: (process.env.PUBLIC_API_URL ?? "http://localhost:3100").replace(/\/+$/, ""),
    paymentSuccessUrl: process.env.PAYMENT_SUCCESS_URL ?? "",
    paymentFailUrl: process.env.PAYMENT_FAIL_URL ?? "",
    botInternalUrl: (process.env.BOT_INTERNAL_URL ?? "http://localhost:3300").replace(/\/+$/, ""),
    serviceToken: process.env.SERVICE_TOKEN ?? "",
    agentToken: process.env.AGENT_TOKEN ?? "",
  };
}

export interface CoreConfig {
  instanceType: "api" | "worker";
  port: number;
  defaultOrgId: string;
  subPublicHost: string;
  profileUpdateIntervalHours: number;
  supportUrl: string;
  announce: string;
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
  };
}

import type { JobName } from "./job.types.js";

export const SCHEDULE_TZ = "Europe/Moscow";

/**
 * Cron-расписание. Минуты разнесены и НЕ попадают на :00 и :30 — иначе всё бьёт
 * одновременно с любым другим шедулером на этой же машине и с внешними API-лимитами.
 */
export const SCHEDULE: Record<JobName, string> = {
  "subscription-expire": "7 * * * *",
  "touchpoints-run": "47 * * * *",
  "node-reconcile-sweep": "3-58/5 * * * *",
  "broadcast-resume": "1-56/5 * * * *",
  "referral-reward-promote": "23 3 * * *",
  "subscription-notify-expire": "13 10 * * *",
  "infra-renewal-reminder": "41 10 * * *",
  "payment-reconcile": "19,49 * * * *",
};

/** Стабильный id планировщика: при рестарте расписание перезаписывается, а не плодится. */
export function schedulerId(name: JobName): string {
  return `cron:${name}`;
}

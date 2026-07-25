import type { DomainList } from "./types.js";

// Приватные сети явными CIDR (в Happ нет geoip → только явные списки).
export const PRIVATE_CIDRS = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

export const DEFAULT_PROBE_URL = "https://cp.cloudflare.com/generate_204";
export const DEFAULT_PROBE_INTERVAL = "10s";
export const RU_DOH = "https://77.88.8.8/dns-query";
export const INTL_DOH = "https://dns.google/dns-query";
/** Запасной plain-DNS: DoH могут порезать вместе с туннелем, без него клиент без резолва. */
export const PLAIN_DNS_FALLBACK = "1.1.1.1";

export interface SplitRoutingParts {
  /** Правила ДО catch-all (block / private→freedom / RU→freedom). Порядок критичен. */
  head: Array<Record<string, unknown>>;
}

/**
 * Geo-free split-routing. Порядок = приоритет (первое совпадение выигрывает).
 *
 * Порядок сверен с боевой выдачей действующей панели (спайк golden-diff):
 *   1. приватные CIDR → freedom
 *   2. bittorrent → block
 *   3. udp:443 (QUIC) → block
 *   4. РФ: зоны + сервисные домены (+ РФ IP-CIDR) → freedom
 * catch-all (→ балансер) и loopback-реинжект добавляет билдер профиля.
 *
 * Приватные сети идут ПЕРВЫМИ намеренно: локальный трафик не должен зависеть
 * ни от блокировок, ни от РФ-списков. Раньше здесь блокировки стояли выше —
 * это расходилось с проверенной боевой конфигурацией.
 *
 * ruSplit=false — обратный сценарий («Россия», «Белые списки»): РФ-ресурсы идут
 * ЧЕРЕЗ туннель, поэтому шаг 4 не добавляется вовсе.
 */
export function buildSplitRoutingHead(list: DomainList, ruSplit = true): SplitRoutingParts {
  const head: Array<Record<string, unknown>> = [];

  // 1. приватные сети → freedom (локалка не должна зависеть от прочих правил)
  head.push({ type: "field", ip: PRIVATE_CIDRS, outboundTag: "freedom" });

  // 2-3. дешёвые барьеры: торренты и QUIC
  head.push({ type: "field", protocol: ["bittorrent"], outboundTag: "block" });
  head.push({ type: "field", network: "udp", port: 443, outboundTag: "block" });

  if (!ruSplit) return { head };

  // 4. РФ-зоны и домены → freedom
  const domains = [
    ...list.zones.map((z) => `domain:${z}`),
    ...list.domains,
  ];
  if (domains.length) {
    head.push({ type: "field", domain: domains, outboundTag: "freedom" });
  }
  if (list.ipCidrs?.length) {
    head.push({ type: "field", ip: list.ipCidrs, outboundTag: "freedom" });
  }

  return { head };
}

/**
 * Split-DNS: РФ DoH для РФ-доменов, зарубежный DoH catch-all, UseIPv4 (иначе AAAA-утечки).
 * ruSplit=false — РФ-резолвер не подключаем: он вернул бы РФ-адреса, а трафик идёт в туннель.
 */
export function buildDns(list: DomainList, ruSplit = true): Record<string, unknown> {
  const ruDomains = [...list.zones.map((z) => `domain:${z}`), ...list.domains];
  // Третий сервер — обычный plain-DNS: если оба DoH недоступны (а их могут резать
  // вместе с туннелем), клиент останется без резолва вообще. Так сделано в боевой
  // конфигурации, сверено спайком golden-diff.
  const servers: Array<unknown> = ruSplit
    ? [{ address: RU_DOH, domains: ruDomains }, INTL_DOH, PLAIN_DNS_FALLBACK]
    : [INTL_DOH, PLAIN_DNS_FALLBACK];
  return { servers, queryStrategy: "UseIPv4" };
}

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
export const INTL_DOH = "https://8.8.8.8/dns-query";

export interface SplitRoutingParts {
  /** Правила ДО catch-all (block / private→freedom / RU→freedom). Порядок критичен. */
  head: Array<Record<string, unknown>>;
}

/**
 * Geo-free split-routing. Порядок = приоритет (первое совпадение выигрывает):
 *   1. udp:443 (QUIC) + bittorrent → block
 *   2. приватные CIDR → freedom
 *   3. РФ: зоны + сервисные домены (+ РФ IP-CIDR) → freedom
 * catch-all (→ балансер) и loopback-реинжект добавляет билдер профиля.
 *
 * ruSplit=false — обратный сценарий («Россия», «Белые списки»): РФ-ресурсы идут
 * ЧЕРЕЗ туннель, поэтому шаг 3 не добавляется вовсе.
 */
export function buildSplitRoutingHead(list: DomainList, ruSplit = true): SplitRoutingParts {
  const head: Array<Record<string, unknown>> = [];

  // 1. block QUIC + bittorrent (первым — дешёвый барьер)
  head.push({ type: "field", network: "udp", port: 443, outboundTag: "block" });
  head.push({ type: "field", protocol: ["bittorrent"], outboundTag: "block" });

  // 2. приватные сети → freedom (напрямую, не в туннель)
  head.push({ type: "field", ip: PRIVATE_CIDRS, outboundTag: "freedom" });

  if (!ruSplit) return { head };

  // 3. РФ-зоны и домены → freedom
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
  const servers: Array<unknown> = ruSplit
    ? [{ address: RU_DOH, domains: ruDomains }, INTL_DOH]
    : [INTL_DOH];
  return { servers, queryStrategy: "UseIPv4" };
}

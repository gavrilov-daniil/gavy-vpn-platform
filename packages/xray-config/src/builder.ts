import type {
  ChannelInput,
  FrontOutbound,
  GeneratorInput,
  HostRef,
  ProfileInput,
  RenderedProfile,
  XrayConfig,
} from "./types.js";
import { VISION } from "./types.js";
import {
  DEFAULT_PROBE_INTERVAL,
  DEFAULT_PROBE_URL,
  buildDns,
  buildSplitRoutingHead,
} from "./split-routing.js";

// Пользовательские inbound'ы клиента (socks + http), sniffing routeOnly (иначе ломается direct-матч по IP).
function userInbounds(): Array<Record<string, unknown>> {
  const sniffing = { enabled: true, destOverride: ["http", "tls", "quic"], routeOnly: true };
  return [
    { tag: "socks-in", listen: "127.0.0.1", port: 10808, protocol: "socks", settings: { udp: true }, sniffing },
    { tag: "http-in", listen: "127.0.0.1", port: 10809, protocol: "http", sniffing },
  ];
}

function realityStream(host: HostRef, dialerProxyTag?: string): Record<string, unknown> {
  const stream: Record<string, unknown> = {
    network: host.network ?? "tcp",
    security: "reality",
    realitySettings: {
      serverName: host.sni,
      fingerprint: host.fingerprint,
      publicKey: host.pbk,
      shortId: host.sid,
    },
  };
  if (dialerProxyTag) stream.sockopt = { dialerProxy: dialerProxyTag };
  return stream;
}

function vlessOutbound(tag: string, uuid: string, host: HostRef, dialerProxyTag?: string): Record<string, unknown> {
  return {
    tag,
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: host.address,
          port: host.port,
          users: [{ id: uuid, encryption: "none", flow: host.flow || "" }],
        },
      ],
    },
    streamSettings: realityStream(host, dialerProxyTag),
  };
}

function channelOutbound(ch: ChannelInput, input: GeneratorInput): Record<string, unknown> {
  if (ch.kind === "direct") {
    return vlessOutbound(ch.tag, input.vlessUuid, ch.host);
  }
  // cascade: клон exit-outbound с dialerProxy=front, ОБА плеча flow=vision
  if (!input.front) {
    throw new Error(`cascade channel ${ch.tag} requires a front outbound`);
  }
  return vlessOutbound(ch.tag, input.vlessUuid, ch.host, input.front.tag);
}

function frontOutbound(front: FrontOutbound, uuid: string): Record<string, unknown> {
  return vlessOutbound(front.tag, uuid, front.host);
}

const FREEDOM = { tag: "freedom", protocol: "freedom", settings: { domainStrategy: "UseIPv4" } };
const BLOCK = { tag: "block", protocol: "blackhole" };

/** Строит ОДИН полный Xray-конфиг для профиля (свой балансер, observatory, loopback, split). */
export function buildProfileConfig(input: GeneratorInput, profile: ProfileInput): XrayConfig {
  const byTag = new Map(input.channels.map((c) => [c.tag, c]));
  const primary = profile.primary.map((t) => must(byTag, t));
  const fallback = profile.fallback.map((t) => must(byTag, t));

  const hasFallback = fallback.length > 0;
  const hasCascade = [...primary, ...fallback].some((c) => c.kind === "cascade");

  // --- outbounds ---
  const outbounds: Array<Record<string, unknown>> = [];
  for (const ch of primary) outbounds.push(channelOutbound(ch, input));
  for (const ch of fallback) outbounds.push(channelOutbound(ch, input));
  if (hasCascade && input.front) outbounds.push(frontOutbound(input.front, input.vlessUuid));
  outbounds.push({ ...FREEDOM });
  outbounds.push({ ...BLOCK });
  if (hasFallback) {
    outbounds.push({ tag: "lo-out-1", protocol: "loopback", settings: { inboundTag: "lo-in-1" } });
  }

  // --- inbounds ---
  const inbounds = userInbounds();
  if (hasFallback) {
    inbounds.push({
      tag: "lo-in-1",
      listen: "127.0.0.1",
      port: 0,
      protocol: "dokodemo-door",
      settings: { network: "tcp,udp", followRedirect: true },
    });
  }

  // --- balancers (tier1 direct, tier2 cascade). Последний tier — БЕЗ fallbackTag. ---
  const tier1Selector = primary.map((c) => c.tag);
  const balancers: Array<Record<string, unknown>> = [];
  if (hasFallback) {
    balancers.push({ tag: "tier1", selector: tier1Selector, fallbackTag: "lo-out-1", strategy: { type: "leastPing" } });
    balancers.push({ tag: "tier2", selector: fallback.map((c) => c.tag), strategy: { type: "leastPing" } });
  } else {
    // один тир (напр. FI: direct нет — единственный балансер без fallback)
    const only = primary.length ? primary : fallback;
    balancers.push({ tag: "tier1", selector: only.map((c) => c.tag), strategy: { type: "leastPing" } });
  }

  // --- routing rules ---
  const ruSplit = profile.ruSplit !== false;
  const { head } = buildSplitRoutingHead(input.domainList, ruSplit);
  const rules = [...head];
  if (hasFallback) {
    // loopback-реинжект ДО catch-all
    rules.push({ type: "field", inboundTag: ["lo-in-1"], balancerTag: "tier2" });
  }
  rules.push({ type: "field", network: "tcp,udp", balancerTag: "tier1" });

  // --- observatory: top-level (не burst), subjectSelector = union всех selector ---
  const subjectSelector = uniq(balancers.flatMap((b) => b.selector as string[]));
  const observatory = {
    subjectSelector,
    probeUrl: input.probeUrl ?? DEFAULT_PROBE_URL,
    probeInterval: input.probeInterval ?? DEFAULT_PROBE_INTERVAL,
  };

  return {
    log: { loglevel: "warning" },
    dns: buildDns(input.domainList, ruSplit),
    inbounds,
    outbounds,
    routing: { domainStrategy: "AsIs", balancers, rules },
    observatory,
  };
}

/** Профиль «Авто»: все direct в primary, все cascade в fallback. Эквивалент базового Remnawave-вывода. */
export function autoProfile(input: GeneratorInput): ProfileInput {
  return {
    remark: "🔀 Авто",
    isAuto: true,
    primary: input.channels.filter((c) => c.kind === "direct").map((c) => c.tag),
    fallback: input.channels.filter((c) => c.kind === "cascade").map((c) => c.tag),
  };
}

/** База = конфиг профиля «Авто» со всеми каналами. Против него идёт golden byte-diff (спайк 1). */
export function assembleBase(input: GeneratorInput): XrayConfig {
  return buildProfileConfig(input, autoProfile(input));
}

/** VARIANTS-проекция: массив полных конфигов по профилям (формат мульти-профильной подписки Happ). */
export function projectVariants(input: GeneratorInput, profiles: ProfileInput[]): RenderedProfile[] {
  return profiles.map((p) => ({ remark: p.remark, config: buildProfileConfig(input, p) }));
}

function must<T>(map: Map<string, T>, key: string): T {
  const v = map.get(key);
  if (v === undefined) throw new Error(`channel not found: ${key}`);
  return v;
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

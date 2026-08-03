/**
 * Панель-заглушка для тестов импорта. Тестов здесь нет — только сборка ответов
 * Remnawave той же формы, что отдаёт боевая 2.7.4 (снято read-only с panel.gavy.shop).
 *
 * Модель панели воспроизведена как есть: config-профиль владеет inbound'ами, нода
 * ссылается на профиль и держит ПОДМНОЖЕСТВО его inbound'ов, host ссылается на
 * inbound профиля. Ровно на этих трёх связях держится весь перенос.
 */
import { randomUUID } from "node:crypto";
import type {
  RemnawaveClient,
  RemnawaveConfigProfile,
  RemnawaveHost,
  RemnawaveInbound,
  RemnawaveNode,
  RemnawaveSquad,
  RemnawaveUser,
} from "./remnawave.client.js";

/**
 * Эталонная пара x25519 из RFC 7748 §6.1 (приватник Alice и его публичная часть).
 * Взята из стандарта, а не посчитана нашим же кодом: иначе тест на вывод `pbk`
 * подтверждал бы сам себя.
 */
export const REALITY_VECTOR = {
  privateKey: Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex").toString(
    "base64url",
  ),
  publicKey: Buffer.from("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", "hex").toString(
    "base64url",
  ),
};

export interface InboundSpec {
  tag: string;
  port?: number;
  type?: string;
  network?: string;
  security?: string;
  shortIds?: string[];
  serverNames?: string[];
  /** null — панель приватник не отдала: pbk вывести не из чего. */
  privateKey?: string | null;
  dest?: string;
  sniffingEnabled?: boolean;
  /** Порт отсутствует в ответе панели вовсе. */
  noPort?: boolean;
}

export interface NodeSpec {
  name: string;
  address: string;
  cc?: string;
  /** Теги inbound'ов профиля, реально поднятые на этой ноде. По умолчанию — все. */
  active?: string[];
  isDisabled?: boolean;
  viewPosition?: number;
  consumptionMultiplier?: number;
  isTrafficTrackingActive?: boolean;
}

export interface HostSpec {
  remark: string;
  address: string;
  port?: number;
  /** Тег inbound'а, на который смотрит host. */
  tag: string;
  sni?: string | null;
  fingerprint?: string | null;
  alpn?: string | null;
  isHidden?: boolean;
  isDisabled?: boolean;
  viewPosition?: number;
}

export interface PanelSpec {
  profiles: Array<{ name: string; inbounds: InboundSpec[]; nodes: NodeSpec[] }>;
  hosts?: HostSpec[];
  squads?: Array<{ name: string; tags: string[] }>;
  users?: RemnawaveUser[];
}

export interface PanelData {
  nodes: RemnawaveNode[];
  profiles: RemnawaveConfigProfile[];
  hosts: RemnawaveHost[];
  squads: RemnawaveSquad[];
  users: RemnawaveUser[];
  inboundUuidByTag: Map<string, string>;
}

function buildInbound(spec: InboundSpec): RemnawaveInbound {
  const security = spec.security ?? "reality";
  const network = spec.network ?? "tcp";
  const port = spec.port ?? 443;
  const serverNames = spec.serverNames ?? ["ads.x5.ru"];
  const reality =
    security === "reality"
      ? {
          dest: spec.dest ?? `${serverNames[0]}:443`,
          show: false,
          xver: 0,
          shortIds: spec.shortIds ?? ["57ced396c15964fe"],
          serverNames,
          ...(spec.privateKey === null ? {} : { privateKey: spec.privateKey ?? REALITY_VECTOR.privateKey }),
        }
      : null;

  return {
    uuid: randomUUID(),
    tag: spec.tag,
    type: spec.type ?? "vless",
    network,
    security,
    port: spec.noPort ? null : port,
    rawInbound: {
      tag: spec.tag,
      ...(spec.noPort ? {} : { port }),
      protocol: spec.type ?? "vless",
      settings: { clients: [], decryption: "none" },
      sniffing: { enabled: spec.sniffingEnabled ?? true, destOverride: ["http", "tls", "quic"] },
      streamSettings: { network, security, realitySettings: reality },
    },
  };
}

export function panelData(spec: PanelSpec): PanelData {
  const profiles: RemnawaveConfigProfile[] = [];
  const nodes: RemnawaveNode[] = [];
  const inboundUuidByTag = new Map<string, string>();

  for (const p of spec.profiles) {
    const inbounds = p.inbounds.map(buildInbound);
    for (const i of inbounds) inboundUuidByTag.set(i.tag, i.uuid);
    const profileUuid = randomUUID();

    profiles.push({
      uuid: profileUuid,
      name: p.name,
      inbounds,
      nodes: p.nodes.map((n) => ({ uuid: randomUUID(), name: n.name, countryCode: n.cc ?? "DE" })),
    });

    for (const n of p.nodes) {
      const active = inbounds.filter((i) => !n.active || n.active.includes(i.tag));
      nodes.push({
        uuid: randomUUID(),
        name: n.name,
        address: n.address,
        port: 2222,
        countryCode: n.cc ?? "DE",
        isDisabled: n.isDisabled ?? false,
        isTrafficTrackingActive: n.isTrafficTrackingActive ?? false,
        consumptionMultiplier: n.consumptionMultiplier ?? 1,
        viewPosition: n.viewPosition ?? 0,
        configProfile: {
          activeConfigProfileUuid: profileUuid,
          // панель отдаёт в ноде укороченный inbound без rawInbound — Reality лежит
          // только в /api/config-profiles, и импортёр обязан ходить именно туда
          activeInbounds: active.map((i) => ({
            uuid: i.uuid,
            tag: i.tag,
            type: i.type,
            network: i.network,
            security: i.security,
            port: i.port,
          })),
        },
      });
    }
  }

  const hosts: RemnawaveHost[] = (spec.hosts ?? []).map((h) => ({
    uuid: randomUUID(),
    remark: h.remark,
    address: h.address,
    port: h.port ?? 443,
    sni: h.sni === undefined ? "ads.x5.ru" : h.sni,
    fingerprint: h.fingerprint === undefined ? "firefox" : h.fingerprint,
    alpn: h.alpn ?? null,
    isHidden: h.isHidden ?? false,
    isDisabled: h.isDisabled ?? false,
    viewPosition: h.viewPosition ?? 0,
    securityLayer: "DEFAULT",
    inbound: { configProfileInboundUuid: inboundUuidByTag.get(h.tag) ?? `unknown:${h.tag}` },
  }));

  const squads: RemnawaveSquad[] = (spec.squads ?? []).map((s) => ({
    uuid: randomUUID(),
    name: s.name,
    inbounds: s.tags.map((tag) => ({
      uuid: inboundUuidByTag.get(tag) ?? randomUUID(),
      tag,
      profileUuid: null,
      type: "vless",
      port: 443,
    })),
  }));

  return { nodes, profiles, hosts, squads, users: spec.users ?? [], inboundUuidByTag };
}

/** Клиент панели поверх готового снимка: сервисы ходят только в эти методы. */
export function fakePanel(data: Partial<PanelData>): RemnawaveClient {
  return {
    isConfigured: () => true,
    listNodes: async () => data.nodes ?? [],
    listConfigProfiles: async () => data.profiles ?? [],
    listHosts: async () => data.hosts ?? [],
    listSquads: async () => data.squads ?? [],
    listUsers: async () => data.users ?? [],
    listDevices: async () => [],
  } as unknown as RemnawaveClient;
}

export function panelUser(patch: Partial<RemnawaveUser> = {}): RemnawaveUser {
  return {
    uuid: randomUUID(),
    username: `panel-${randomUUID().slice(0, 8)}`,
    shortUuid: randomUUID().replace(/-/g, "").slice(0, 16),
    vlessUuid: randomUUID(),
    status: "ACTIVE",
    ...patch,
  };
}

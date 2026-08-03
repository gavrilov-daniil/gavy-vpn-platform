import { Injectable, Logger } from "@nestjs/common";
import { request } from "@corelink/core-kit";

/** Пользователь Remnawave — только те поля, что реально нужны для переноса. */
export interface RemnawaveUser {
  uuid: string;
  username: string;
  shortUuid: string;
  vlessUuid: string;
  trojanPassword?: string | null;
  ssPassword?: string | null;
  telegramId?: number | null;
  email?: string | null;
  status: string;
  expireAt?: string | null;
  trafficLimitBytes?: number | string | null;
  trafficLimitStrategy?: string | null;
  lastTrafficResetAt?: string | null;
  hwidDeviceLimit?: number | null;
  subRevokedAt?: string | null;
  description?: string | null;
  activeInternalSquads?: Array<{ uuid: string; name: string }> | null;
  createdAt?: string | null;
}

/**
 * Inbound панели. `rawInbound` — кусок Xray-конфига ноды: в нём и Reality-идентичность
 * (serverNames/shortIds), и приватник, если панель его хранила. Приватник в нашу БД
 * не попадает никогда — импортёр выводит из него публичную часть и выбрасывает.
 */
export interface RemnawaveInbound {
  uuid: string;
  tag: string;
  profileUuid?: string | null;
  type?: string | null;
  network?: string | null;
  security?: string | null;
  port?: number | null;
  rawInbound?: RawInbound | null;
}

export interface RawInbound {
  tag?: string;
  port?: number;
  protocol?: string;
  sniffing?: { enabled?: boolean; destOverride?: string[]; routeOnly?: boolean } | null;
  streamSettings?: {
    network?: string;
    security?: string;
    realitySettings?: {
      dest?: string;
      show?: boolean;
      xver?: number;
      shortIds?: string[];
      serverNames?: string[];
      privateKey?: string;
    } | null;
  } | null;
  [key: string]: unknown;
}

export interface RemnawaveNode {
  uuid: string;
  name: string;
  address: string;
  port?: number | null;
  countryCode?: string | null;
  isDisabled?: boolean;
  isTrafficTrackingActive?: boolean;
  consumptionMultiplier?: number | null;
  viewPosition?: number | null;
  /** Профиль ноды и ПОДМНОЖЕСТВО его inbound'ов, реально поднятых на этой ноде. */
  configProfile?: { activeConfigProfileUuid?: string | null; activeInbounds?: RemnawaveInbound[] } | null;
}

export interface RemnawaveConfigProfile {
  uuid: string;
  name: string;
  inbounds: RemnawaveInbound[];
  nodes: Array<{ uuid: string; name: string; countryCode?: string | null }>;
}

export interface RemnawaveHost {
  uuid: string;
  remark: string;
  address: string;
  port: number;
  sni?: string | null;
  host?: string | null;
  path?: string | null;
  alpn?: string | null;
  fingerprint?: string | null;
  securityLayer?: string | null;
  allowInsecure?: boolean;
  viewPosition?: number | null;
  isDisabled?: boolean;
  isHidden?: boolean;
  inbound?: { configProfileUuid?: string; configProfileInboundUuid?: string } | null;
  [key: string]: unknown;
}

/** Inbound в составе internal squad'а. Нас интересует только тег — по нему идёт связывание. */
export type RemnawaveSquadInbound = RemnawaveInbound;

export interface RemnawaveSquad {
  uuid: string;
  name: string;
  /** Состав squad'а: какие inbound'ы он открывает. Без него squad — пустая оболочка. */
  inbounds: RemnawaveSquadInbound[];
  info?: unknown;
}

/** Сырой ответ панели: помимо нужных полей несёт rawInbound и счётчики, которые мы отбрасываем. */
interface RawSquad {
  uuid: string;
  name: string;
  info?: unknown;
  inbounds?: Array<Partial<RemnawaveSquadInbound>> | null;
}

/**
 * Read-only клиент к действующей панели. Пишущих методов здесь нет намеренно:
 * во время миграции обе панели живы, и любая запись в старую — это шанс
 * разъехаться с реальностью на ноде.
 */
@Injectable()
export class RemnawaveClient {
  private readonly log = new Logger(RemnawaveClient.name);

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  /** Пагинация: панель отдаёт максимум N за раз, а юзеров сотни. */
  async listUsers(pageSize = 200): Promise<RemnawaveUser[]> {
    const all: RemnawaveUser[] = [];
    let start = 0;

    for (;;) {
      const res = await this.get<{ response?: { users?: RemnawaveUser[]; total?: number } | RemnawaveUser[] }>(
        `/api/users?size=${pageSize}&start=${start}`,
      );
      const chunk = this.unwrapUsers(res);
      all.push(...chunk);
      if (chunk.length < pageSize) break;
      start += pageSize;
      if (start > 100_000) break; // предохранитель от бесконечного цикла на кривом ответе
    }
    return all;
  }

  async listNodes(): Promise<RemnawaveNode[]> {
    const res = await this.get<{ response?: RemnawaveNode[] }>("/api/nodes");
    return res.response ?? [];
  }

  async listHosts(): Promise<RemnawaveHost[]> {
    const res = await this.get<{ response?: RemnawaveHost[] }>("/api/hosts");
    return res.response ?? [];
  }

  /**
   * Config-профили со всем составом inbound'ов. Ответ ноды (`/api/nodes`) несёт только
   * активные на ней inbound'ы, но именно здесь лежит `rawInbound` с Reality-настройками
   * — без этого запроса pbk и shortIds взять неоткуда.
   */
  async listConfigProfiles(): Promise<RemnawaveConfigProfile[]> {
    const res = await this.get<{
      response?: { configProfiles?: RemnawaveConfigProfile[] } | RemnawaveConfigProfile[];
    }>("/api/config-profiles");
    const body = res.response;
    const list = Array.isArray(body) ? body : (body?.configProfiles ?? []);
    return list.map((p) => ({
      uuid: p.uuid,
      name: p.name,
      inbounds: p.inbounds ?? [],
      nodes: p.nodes ?? [],
    }));
  }

  /**
   * Squad'ы вместе с их составом. Панель отдаёт inbound'ы прямо в этом ответе
   * (поле `inbounds` с тегом и профилем), отдельный запрос не нужен. Из `rawInbound`
   * не берём ничего: шейп inbound'а у нас свой, связывание идёт по тегу.
   */
  async listSquads(): Promise<RemnawaveSquad[]> {
    const res = await this.get<{
      response?: { internalSquads?: RawSquad[] } | RawSquad[];
    }>("/api/internal-squads");
    const body = res.response;
    const list = Array.isArray(body) ? body : (body?.internalSquads ?? []);

    return list.map((s) => ({
      uuid: s.uuid,
      name: s.name,
      info: s.info,
      inbounds: (s.inbounds ?? [])
        .filter((i): i is RemnawaveSquadInbound => Boolean(i?.tag))
        .map((i) => ({
          uuid: i.uuid,
          tag: i.tag,
          profileUuid: i.profileUuid ?? null,
          type: i.type ?? null,
          port: i.port ?? null,
        })),
    }));
  }

  /** Устройства (HWID) конкретного пользователя. Панель отдаёт их отдельным запросом. */
  async listDevices(userUuid: string): Promise<Array<{ hwid: string; platform?: string; deviceModel?: string }>> {
    try {
      const res = await this.get<{ response?: { devices?: Array<Record<string, string>> } }>(
        `/api/hwid/devices/${userUuid}`,
      );
      return (res.response?.devices ?? []).map((d) => ({
        hwid: String(d.hwid ?? ""),
        platform: d.platform,
        deviceModel: d.deviceModel,
      }));
    } catch {
      // у части юзеров устройств нет вовсе — это не ошибка импорта
      return [];
    }
  }

  private unwrapUsers(res: { response?: { users?: RemnawaveUser[] } | RemnawaveUser[] }): RemnawaveUser[] {
    const body = res.response;
    if (Array.isArray(body)) return body;
    return body?.users ?? [];
  }

  private async get<T>(path: string): Promise<T> {
    const res = await request<T>(`${this.baseUrl}${path}`, {
      method: "GET",
      provider: "remnawave",
      headers: { authorization: `Bearer ${this.token}` },
      timeoutMs: 30_000,
      retries: 2,
    });
    return res.body;
  }
}

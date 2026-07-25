import { Injectable, Logger } from "@nestjs/common";
import { request } from "@vpn/core-kit";

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

export interface RemnawaveNode {
  uuid: string;
  name: string;
  address: string;
  port?: number | null;
  countryCode?: string | null;
  isDisabled?: boolean;
  consumptionMultiplier?: number | null;
  viewPosition?: number | null;
}

export interface RemnawaveHost {
  uuid: string;
  remark: string;
  address: string;
  port: number;
  isDisabled?: boolean;
  isHidden?: boolean;
  inbound?: { configProfileUuid?: string; configProfileInboundUuid?: string } | null;
  [key: string]: unknown;
}

export interface RemnawaveSquad {
  uuid: string;
  name: string;
  info?: unknown;
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

  async listSquads(): Promise<RemnawaveSquad[]> {
    const res = await this.get<{ response?: { internalSquads?: RemnawaveSquad[] } | RemnawaveSquad[] }>(
      "/api/internal-squads",
    );
    const body = res.response;
    if (Array.isArray(body)) return body;
    return body?.internalSquads ?? [];
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

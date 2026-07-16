import { Injectable, Logger } from "@nestjs/common";
import { projectVariants, validateConfig, type XrayConfig } from "@vpn/xray-config";
import { loadConfig } from "../config.js";
import { SubscriptionRepository } from "./subscription.repository.js";

export interface DeliveryResult {
  kind: "happ" | "stub";
  body: string;
  headers: Record<string, string>;
}

// Happ ждёт полный текст подписки только на своём UA. Иначе — заглушка тем же форматом (не пустой ответ).
const HAPP_UA = /happ/i;

@Injectable()
export class SubscriptionService {
  private readonly log = new Logger(SubscriptionService.name);
  private readonly cfg = loadConfig();

  constructor(private readonly repo: SubscriptionRepository) {}

  async deliverByShortUuid(shortUuid: string, userAgent: string): Promise<DeliveryResult> {
    const sub = await this.repo.findByShortUuid(this.cfg.defaultOrgId, shortUuid);
    return this.deliver(sub, userAgent);
  }

  async deliverById(id: string, userAgent: string): Promise<DeliveryResult> {
    const sub = await this.repo.findById(this.cfg.defaultOrgId, id);
    return this.deliver(sub, userAgent);
  }

  private async deliver(
    sub: Awaited<ReturnType<SubscriptionRepository["findByShortUuid"]>>,
    userAgent: string,
  ): Promise<DeliveryResult> {
    // защита эндпоинта: только Happ (несущий барьер — не единственный, см. docs/architecture.md)
    if (!HAPP_UA.test(userAgent)) return this.stub("Откройте подписку в приложении Happ.");
    if (!sub) return this.stub("Подписка не найдена.");
    if (sub.status === "disabled" || sub.status === "suspended") {
      return this.stub("Подписка приостановлена.");
    }

    const bundle = await this.repo.loadBundle(this.cfg.defaultOrgId, sub);
    if (!bundle) return this.stub("Профили не настроены.");

    const rendered = projectVariants(bundle.input, bundle.profiles);

    // инвариант-валидатор: не публикуем сломанный конфиг (молчаливый отвал failover)
    for (const r of rendered) {
      const res = validateConfig(r.config);
      if (!res.ok) {
        this.log.error(`config invariant violation [${r.remark}]: ${res.errors.join("; ")}`);
        return this.stub("Временная ошибка конфигурации.");
      }
    }

    // формат Happ: JSON-массив полных конфигов, remarks = имя профиля
    const configs: XrayConfig[] = rendered.map((r) => ({ ...r.config, remarks: r.remark }));
    return {
      kind: "happ",
      body: JSON.stringify(configs),
      headers: this.happHeaders(sub),
    };
  }

  private happHeaders(sub: NonNullable<Awaited<ReturnType<SubscriptionRepository["findByShortUuid"]>>>): Record<string, string> {
    const total = sub.trafficLimitBytes ?? 0;
    const download = sub.usedTrafficBytes ?? 0;
    const expire = sub.expireAt ? Math.floor(new Date(sub.expireAt).getTime() / 1000) : 0;
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      // байт-в-байт совместимо с тем, что ждут мигрированные Happ (migration.md P0-2)
      "subscription-userinfo": `upload=0; download=${download}; total=${total}; expire=${expire}`,
      "profile-update-interval": String(this.cfg.profileUpdateIntervalHours),
      "profile-title": "VPN",
    };
    if (this.cfg.supportUrl) headers["support-url"] = this.cfg.supportUrl;
    if (this.cfg.announce) headers["announce"] = this.cfg.announce;
    return headers;
  }

  private stub(message: string): DeliveryResult {
    // заглушка тем же форматом подписки (один профиль без каналов), чтобы клиент показал сообщение
    const body = JSON.stringify([{ remarks: message, outbounds: [{ tag: "freedom", protocol: "freedom" }] }]);
    return { kind: "stub", body, headers: { "content-type": "application/json; charset=utf-8" } };
  }
}

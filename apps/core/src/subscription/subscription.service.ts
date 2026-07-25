import { Injectable, Logger } from "@nestjs/common";
import { projectVariants, validateConfig, type XrayConfig } from "@vpn/xray-config";
import { loadConfig } from "../config.js";
import { BotClient } from "../bot/bot.client.js";
import { SubscriptionRepository } from "./subscription.repository.js";

export interface DeliveryResult {
  kind: "happ" | "stub" | "error";
  status: number;
  body: string;
  headers: Record<string, string>;
}

// Happ ждёт полный текст подписки только на своём UA. Иначе — заглушка тем же форматом (не пустой ответ).
const HAPP_UA = /happ/i;

const ALERT_THROTTLE_MS = 60 * 60_000;

@Injectable()
export class SubscriptionService {
  private readonly log = new Logger(SubscriptionService.name);
  private readonly cfg = loadConfig();
  private lastAlertAt = 0;

  constructor(
    private readonly repo: SubscriptionRepository,
    private readonly bot: BotClient,
  ) {}

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

    try {
      const bundle = await this.repo.loadBundle(this.cfg.defaultOrgId, sub);
      if (!bundle) return this.failure(sub.shortUuid, "каналы или профили не собрались");

      const rendered = projectVariants(bundle.input, bundle.profiles);

      // инвариант-валидатор: не публикуем сломанный конфиг (молчаливый отвал failover)
      for (const r of rendered) {
        const res = validateConfig(r.config);
        if (!res.ok) return this.failure(sub.shortUuid, `инвариант конфига [${r.remark}]: ${res.errors.join("; ")}`);
      }

      // формат Happ: JSON-массив полных конфигов, remarks = имя профиля
      const configs: XrayConfig[] = rendered.map((r) => ({ ...r.config, remarks: r.remark }));
      return {
        kind: "happ",
        status: 200,
        body: JSON.stringify(configs),
        headers: this.happHeaders(sub),
      };
    } catch (err) {
      return this.failure(sub.shortUuid, err instanceof Error ? err.message : String(err));
    }
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

  /**
   * Штатное пользовательское состояние: подписки нет, приостановлена, зашли не из Happ.
   * Только здесь допустим 200 с заглушкой — клиент осознанно заменяет конфиг на сообщение.
   */
  private stub(message: string): DeliveryResult {
    // заглушка тем же форматом подписки (один профиль без каналов), чтобы клиент показал сообщение
    const body = JSON.stringify([{ remarks: message, outbounds: [{ tag: "freedom", protocol: "freedom" }] }]);
    return { kind: "stub", status: 200, body, headers: { "content-type": "application/json; charset=utf-8" } };
  }

  /**
   * Наша поломка (битые данные, не собрались профили, исключение генератора) — 503, НЕ заглушка.
   * На 5xx Happ оставляет прошлый рабочий конфиг; 200 с заглушкой он принял бы за новую подписку
   * и на плановом обновлении стёр бы рабочие каналы у всей базы разом.
   */
  private failure(shortUuid: string, reason: string): DeliveryResult {
    this.log.error(`подписка ${shortUuid}: сборка не удалась — ${reason}`);
    void this.alertBuildFailure(reason);
    return {
      kind: "error",
      status: 503,
      body: JSON.stringify({ error: "subscription_build_failed" }),
      headers: { "content-type": "application/json; charset=utf-8", "retry-after": "300" },
    };
  }

  /**
   * Троттл in-memory, а не через job_dedup: поломка сборки видна на каждом запросе клиента,
   * и поход в БД ради дедупа добавил бы ещё одну точку отказа на уже сломанном пути.
   * Цена — при N инстансах api до N алертов в час; дубль алерта дешевле пропущенного.
   * Слот занимаем ДО отправки, иначе параллельные запросы проскочат все разом.
   */
  private async alertBuildFailure(reason: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastAlertAt < ALERT_THROTTLE_MS) return;
    this.lastAlertAt = now;
    await this.bot.alert(`🚨 Подписка не собирается, клиентам уходит 503\n<code>${reason.slice(0, 300)}</code>`);
  }
}

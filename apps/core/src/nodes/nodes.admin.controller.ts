import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { NodeStateService } from "./node-state.service.js";
import { CascadeService } from "./cascade.service.js";
import { StatsService } from "./stats.service.js";
import { AbuseService } from "./abuse.service.js";
import { NodeIdentityService } from "./node-identity.service.js";

/** Управление нодами и каскадами из админки. */
@Controller("api/admin")
export class NodesAdminController {
  constructor(
    private readonly state: NodeStateService,
    private readonly cascades: CascadeService,
    private readonly stats: StatsService,
    private readonly abuse: AbuseService,
    private readonly identity: NodeIdentityService,
  ) {}

  /**
   * Выпустить одноразовый bootstrap-токен для энроллмента ноды.
   * Значение возвращается ЕДИНСТВЕННЫЙ раз: в БД лежит только его хеш.
   */
  @Post("nodes/:id/enrollment")
  issueEnrollment(@Param("id") id: string) {
    return this.identity.issueBootstrapToken(id);
  }

  /** Пересобрать desired-state ноды (после смены inbound'ов, планов, доступов). */
  @Post("nodes/:id/rebuild")
  rebuild(@Param("id") id: string) {
    return this.state.rebuild(id);
  }

  @Get("nodes/:id/desired-state")
  desired(@Param("id") id: string) {
    return this.state.getDesiredState(id);
  }

  @Get("cascades")
  list() {
    return this.cascades.list();
  }

  /** Скрестить relay с exit (или объявить client-chain через front). */
  @Post("cascades")
  link(
    @Body()
    body: {
      kind: "server_forward" | "client_chain";
      cc: string;
      exitNodeId: string;
      exitInboundTag: string;
      relayNodeId?: string;
      frontNodeId?: string;
    },
  ) {
    return this.cascades.link(body);
  }

  @Post("cascades/:id/refresh")
  refresh(@Param("id") id: string) {
    return this.cascades.refreshStatus(id);
  }

  /** Привязать канал подписки к каскаду — иначе выдача не проверит его готовность. */
  @Post("cascades/:id/attach-channel")
  attachChannel(@Param("id") id: string, @Body() body: { channelId: string }) {
    return this.cascades.attachChannel(id, body.channelId);
  }

  @Get("usage/:shortUuid")
  usage(@Param("shortUuid") shortUuid: string) {
    return this.stats.usageBySubscription(shortUuid);
  }

  /** Устройства подписки: что подключалось и когда. Байт по устройству нет — см. StatsService. */
  @Get("usage/:shortUuid/devices")
  devices(@Param("shortUuid") shortUuid: string) {
    return this.stats.devicesBySubscription(shortUuid);
  }

  /** Сводка трафика: итоги, по дням, по нодам/странам + состав парка устройств. */
  @Get("stats/overview")
  statsOverview(@Query("days") days?: string) {
    return this.stats.overview(positiveInt(days, 30));
  }

  @Get("stats/top-subscribers")
  statsTop(@Query("days") days?: string, @Query("limit") limit?: string) {
    return this.stats.topSubscribers(positiveInt(days, 30), positiveInt(limit, 50));
  }

  /** Прогон детекта абьюза по накопленной статистике. */
  @Post("abuse/scan")
  scanAbuse(@Body() body: { volumeBytesPerWindow?: number; seedingRatio?: number; ipFanout?: number; windowHours?: number }) {
    return this.abuse.scan(body ?? {});
  }

  @Get("abuse/signals")
  signals() {
    return this.abuse.listSignals();
  }

  @Get("abuse/actions")
  actions() {
    return this.abuse.listActions();
  }

  @Post("abuse/release/:subscriptionId")
  release(@Param("subscriptionId") subscriptionId: string) {
    return this.abuse.release(subscriptionId);
  }
}

/** Query-параметры приходят строками; мусор не должен уезжать в LIMIT/период запроса. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

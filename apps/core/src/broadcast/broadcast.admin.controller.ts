import { BadRequestException, Body, Controller, Get, Logger, Param, Patch, Post } from "@nestjs/common";
import { BroadcastService } from "./broadcast.service.js";
import { SEGMENT_KINDS, type SegmentKind } from "./segment.service.js";
import { TouchpointService } from "./touchpoint.service.js";

@Controller("api/admin")
export class BroadcastAdminController {
  private readonly log = new Logger(BroadcastAdminController.name);

  constructor(
    private readonly broadcasts: BroadcastService,
    private readonly touchpoints: TouchpointService,
  ) {}

  @Get("broadcasts")
  list() {
    return this.broadcasts.list();
  }

  @Post("broadcasts")
  create(
    @Body()
    body: {
      title: string;
      segmentKind: string;
      segmentId?: string;
      bodyHtml: string;
      buttons?: Record<string, unknown>[];
      throttlePerSec?: number;
      imageFileId?: string;
      expiringDays?: number;
    },
  ) {
    if (!body.title || !body.bodyHtml) throw new BadRequestException("нужны title и bodyHtml");
    if (!SEGMENT_KINDS.includes(body.segmentKind as SegmentKind)) {
      throw new BadRequestException(`segmentKind должен быть одним из: ${SEGMENT_KINDS.join(", ")}`);
    }
    return this.broadcasts.create({ ...body, segmentKind: body.segmentKind as SegmentKind });
  }

  @Get("broadcasts/:id")
  get(@Param("id") id: string) {
    return this.broadcasts.get(id);
  }

  /**
   * Прогон идёт фоном в этом процессе: держать HTTP-соединение на всё время рассылки нельзя.
   * Прогресс — через GET broadcasts/:id.
   *
   * Аренда берётся ДО ответа, а не внутри фоновой задачи: иначе два клика подряд оба
   * получили бы started=true, и о том, что второй прогон не стартовал, оператор узнал бы
   * только из логов. Та же аренда у джобы broadcast-resume — гнать рассылку в два потока
   * нельзя, Telegram отвечает на удвоенный темп 429.
   */
  @Post("broadcasts/:id/run")
  async run(@Param("id") id: string) {
    await this.broadcasts.get(id);

    const claim = await this.broadcasts.claim(id);
    if (!claim.ok) return { started: false, reason: claim.reason };

    this.drainInBackground(id);
    return { started: true };
  }

  /** Повтор для тех, у кого отправка сорвалась технически. Прогон — тоже фоном, как и run. */
  @Post("broadcasts/:id/retry-failed")
  async retryFailed(@Param("id") id: string) {
    const result = await this.broadcasts.retryFailed(id);
    if (!result.ok || result.retried === 0) return { ...result, started: false };

    const claim = await this.broadcasts.claim(id);
    if (!claim.ok) return { ...result, started: false, reason: claim.reason };

    this.drainInBackground(id);
    return { ...result, started: true };
  }

  private drainInBackground(id: string): void {
    void this.broadcasts
      .drain(id)
      .catch((err) => this.log.error(`broadcast ${id} упал: ${err instanceof Error ? err.message : String(err)}`));
  }

  @Post("broadcasts/:id/cancel")
  cancel(@Param("id") id: string) {
    return this.broadcasts.cancel(id);
  }

  @Get("touchpoints")
  listTouchpoints() {
    return this.touchpoints.list();
  }

  @Post("touchpoints")
  createTouchpoint(
    @Body()
    body: {
      name: string;
      triggerKey: string;
      triggerType?: string;
      delayHours?: number;
      bodyHtml: string;
      buttons?: Record<string, unknown>[];
      quietHours?: { from: number; to: number };
      isActive?: boolean;
    },
  ) {
    if (!body.name || !body.triggerKey || !body.bodyHtml) {
      throw new BadRequestException("нужны name, triggerKey и bodyHtml");
    }
    return this.touchpoints.create(body);
  }

  /** Ручной прогон касаний; штатно вызывается планировщиком по этому же пути. */
  @Post("touchpoints/run")
  runTouchpoints() {
    return this.touchpoints.runTouchpoints();
  }

  @Patch("touchpoints/:id")
  updateTouchpoint(
    @Param("id") id: string,
    @Body()
    body: {
      name?: string;
      triggerKey?: string;
      triggerType?: string;
      delayHours?: number;
      bodyHtml?: string;
      buttons?: Record<string, unknown>[];
      quietHours?: { from: number; to: number } | null;
      isActive?: boolean;
    },
  ) {
    return this.touchpoints.update(id, body);
  }
}

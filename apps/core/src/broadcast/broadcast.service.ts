import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { DispatchService } from "./dispatch.service.js";
import { SegmentService, type SegmentKind } from "./segment.service.js";

export interface CreateBroadcastInput {
  title: string;
  segmentKind: SegmentKind;
  segmentId?: string | null;
  bodyHtml: string;
  buttons?: Record<string, unknown>[];
  throttlePerSec?: number;
  imageFileId?: string | null;
  expiringDays?: number;
}

const BATCH_SIZE = 500;
const INSERT_CHUNK = 1000;
const RUNNABLE_STATUSES = ["draft", "scheduled", "running"] as const;

/** Аренда рассылки. Переживший процесс не должен держать её вечно, поэтому с истечением. */
const LEASE_MINUTES = 5;
/** Продление на ходу: прогон длиннее аренды, иначе её перехватит следующий тик джобы. */
const LEASE_RENEW_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class BroadcastService {
  private readonly log = new Logger(BroadcastService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly segments: SegmentService,
    private readonly dispatch: DispatchService,
  ) {}

  /**
   * Получатели материализуются сразу при создании: рассылка становится возобновляемой
   * (упал воркер — второй запуск доберёт pending) и её размер известен до старта.
   */
  async create(input: CreateBroadcastInput) {
    const [row] = await this.db
      .insert(schema.broadcast)
      .values({
        orgId: this.cfg.defaultOrgId,
        title: input.title,
        segmentKind: input.segmentKind,
        segmentId: input.segmentId ?? undefined,
        bodyHtml: input.bodyHtml,
        buttons: input.buttons ?? [],
        imageFileId: input.imageFileId ?? undefined,
        throttlePerSec: input.throttlePerSec ?? 20,
      })
      .returning();

    const members = await this.segments.resolve({
      kind: input.segmentKind,
      segmentId: input.segmentId,
      expiringDays: input.expiringDays,
    });

    let recipients = 0;
    for (let i = 0; i < members.length; i += INSERT_CHUNK) {
      const inserted = await this.db
        .insert(schema.broadcastRecipient)
        .values(
          members.slice(i, i + INSERT_CHUNK).map((m) => ({
            orgId: this.cfg.defaultOrgId,
            broadcastId: row.id,
            subscriberId: m.subscriberId,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: schema.broadcastRecipient.id });
      recipients += inserted.length;
    }

    this.log.log(`broadcast ${row.id} создан: ${recipients} получателей (${input.segmentKind})`);
    return { broadcast: row, recipients };
  }

  /**
   * Взять аренду на прогон. Единственная точка входа в рассылку — и для джобы
   * broadcast-resume, и для кнопки в админке.
   *
   * Аренда — `broadcast.started_at`, а не Set в памяти: ручной прогон идёт
   * fire-and-forget в процессе api, добор — в процессе воркера, и друг друга они
   * в памяти не видят. Без общей аренды одну рассылку гнали бы два потока: дубли
   * сообщений гасит dedup_key в message_log, но фактический темп выходит вдвое
   * выше throttle_per_sec, и Telegram отвечает 429.
   *
   * `started_at` со сроком в 5 минут, а не «взял навсегда»: процесс, умерший
   * посреди прогона, иначе запер бы рассылку до ручного вмешательства.
   */
  async claim(broadcastId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const claimed = await this.db
      .update(schema.broadcast)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.broadcast.orgId, this.cfg.defaultOrgId),
          eq(schema.broadcast.id, broadcastId),
          inArray(schema.broadcast.status, [...RUNNABLE_STATUSES]),
          // draft/scheduled арендовать некому — прогона ещё не было; у running аренду
          // отдаём, только если её никто не держит или держатель отвалился
          or(
            ne(schema.broadcast.status, "running"),
            isNull(schema.broadcast.startedAt),
            sql`${schema.broadcast.startedAt} < now() - ${`${LEASE_MINUTES} minutes`}::interval`,
          ),
        ),
      )
      .returning({ id: schema.broadcast.id });

    if (claimed.length > 0) return { ok: true };

    const current = await this.getRow(broadcastId);
    if (current.status === "running") return { ok: false, reason: "рассылка уже выполняется" };
    return { ok: false, reason: `нельзя запустить рассылку в статусе ${current.status}` };
  }

  /** Аренда + прогон. Для вызывающего, которому не нужно отвечать до начала рассылки. */
  async run(broadcastId: string) {
    const claim = await this.claim(broadcastId);
    if (!claim.ok) return { ok: false as const, reason: claim.reason };
    return this.drain(broadcastId);
  }

  /**
   * Отправка под УЖЕ взятой арендой. Вызывать только после успешного claim():
   * второй drain на той же рассылке — это тот самый двойной темп.
   */
  async drain(broadcastId: string) {
    const broadcast = await this.getRow(broadcastId);
    const pauseMs = Math.ceil(1000 / Math.max(broadcast.throttlePerSec, 1));
    const counts = { sent: 0, failed: 0, skipped: 0, duplicate: 0 };

    const renew = setInterval(() => {
      void this.renewLease(broadcastId);
    }, LEASE_RENEW_MS);
    renew.unref();

    try {
      for (;;) {
        const fresh = await this.getRow(broadcastId);
        if (fresh.status === "canceled") {
          this.log.warn(`broadcast ${broadcastId} отменён на ходу, остановлен`);
          return { ok: true as const, canceled: true, ...counts };
        }

        const batch = await this.db
          .select({ recipient: schema.broadcastRecipient, subscriber: schema.subscriber })
          .from(schema.broadcastRecipient)
          .innerJoin(schema.subscriber, eq(schema.broadcastRecipient.subscriberId, schema.subscriber.id))
          .where(
            and(
              eq(schema.broadcastRecipient.orgId, this.cfg.defaultOrgId),
              eq(schema.broadcastRecipient.broadcastId, broadcastId),
              eq(schema.broadcastRecipient.status, "pending"),
            ),
          )
          .limit(BATCH_SIZE);
        if (batch.length === 0) break;

        for (const { recipient, subscriber } of batch) {
          if (subscriber.telegramId === null) {
            await this.markRecipient(recipient.id, "skipped", "no_telegram_id");
            counts.skipped++;
            continue;
          }

          const result = await this.dispatch.send({
            subscriberId: subscriber.id,
            telegramId: subscriber.telegramId,
            kind: "broadcast",
            refId: broadcastId,
            dedupKey: `broadcast:${broadcastId}:${subscriber.id}`,
            bodyHtml: broadcast.bodyHtml,
            buttons: broadcast.buttons,
            imageFileId: broadcast.imageFileId,
          });

          if (result.outcome === "sent") {
            await this.markRecipient(recipient.id, "sent");
            counts.sent++;
          } else if (result.outcome === "duplicate") {
            // адресату уже отправляли в прошлом запуске — приводим строку к факту
            await this.markRecipient(recipient.id, "sent");
            counts.duplicate++;
          } else {
            await this.markRecipient(recipient.id, "failed", result.outcome === "blocked" ? "blocked" : "error");
            counts.failed++;
          }

          await sleep(pauseMs);
        }
      }
    } finally {
      clearInterval(renew);
    }

    await this.db
      .update(schema.broadcast)
      .set({ status: "done", finishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.broadcast.orgId, this.cfg.defaultOrgId),
          eq(schema.broadcast.id, broadcastId),
          eq(schema.broadcast.status, "running"),
        ),
      );

    this.log.log(`broadcast ${broadcastId} завершён: ${JSON.stringify(counts)}`);
    return { ok: true as const, canceled: false, ...counts };
  }

  /** Продление аренды на ходу. Сбой продления не имеет права уронить сам прогон. */
  private async renewLease(broadcastId: string): Promise<void> {
    try {
      await this.db
        .update(schema.broadcast)
        .set({ startedAt: new Date() })
        .where(
          and(
            eq(schema.broadcast.orgId, this.cfg.defaultOrgId),
            eq(schema.broadcast.id, broadcastId),
            eq(schema.broadcast.status, "running"),
          ),
        );
    } catch (err) {
      this.log.warn(
        `не удалось продлить аренду рассылки ${broadcastId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Возврат в очередь получателей, у которых отправка сорвалась технически (reason='error':
   * бот лежал, таймаут, 5xx). blocked/skipped не трогаем — там повтор бессмыслен.
   * Claim в message_log на таких отправках уже снят DispatchService, поэтому прогон
   * действительно отправит сообщение, а не отбросит его как дубль.
   */
  async retryFailed(broadcastId: string) {
    const broadcast = await this.getRow(broadcastId);
    if (broadcast.status === "running") {
      return { ok: false as const, reason: "рассылка выполняется, повтор запустится после её завершения" };
    }

    const reset = await this.db
      .update(schema.broadcastRecipient)
      .set({ status: "pending", reason: null, sentAt: null })
      .where(
        and(
          eq(schema.broadcastRecipient.orgId, this.cfg.defaultOrgId),
          eq(schema.broadcastRecipient.broadcastId, broadcastId),
          eq(schema.broadcastRecipient.status, "failed"),
          eq(schema.broadcastRecipient.reason, "error"),
        ),
      )
      .returning({ id: schema.broadcastRecipient.id });

    if (reset.length === 0) return { ok: true as const, retried: 0 };

    // завершённую рассылку возвращаем в запускаемый статус — run() берёт только draft/scheduled/running
    await this.db
      .update(schema.broadcast)
      .set({ status: "scheduled", finishedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(schema.broadcast.orgId, this.cfg.defaultOrgId),
          eq(schema.broadcast.id, broadcastId),
          inArray(schema.broadcast.status, ["done", "canceled"]),
        ),
      );

    this.log.log(`broadcast ${broadcastId}: ${reset.length} получателей возвращены в pending`);
    return { ok: true as const, retried: reset.length };
  }

  async cancel(broadcastId: string) {
    const [row] = await this.db
      .update(schema.broadcast)
      .set({ status: "canceled", finishedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.broadcast.orgId, this.cfg.defaultOrgId),
          eq(schema.broadcast.id, broadcastId),
          inArray(schema.broadcast.status, [...RUNNABLE_STATUSES]),
        ),
      )
      .returning();
    if (!row) {
      const current = await this.getRow(broadcastId);
      return { ok: false as const, reason: `рассылка уже в статусе ${current.status}` };
    }
    return { ok: true as const, broadcast: row };
  }

  async list() {
    const rows = await this.db
      .select()
      .from(schema.broadcast)
      .where(eq(schema.broadcast.orgId, this.cfg.defaultOrgId))
      .orderBy(desc(schema.broadcast.createdAt));

    const stats = await this.db
      .select({
        broadcastId: schema.broadcastRecipient.broadcastId,
        status: schema.broadcastRecipient.status,
        count: sql<string>`count(*)`,
      })
      .from(schema.broadcastRecipient)
      .where(eq(schema.broadcastRecipient.orgId, this.cfg.defaultOrgId))
      .groupBy(schema.broadcastRecipient.broadcastId, schema.broadcastRecipient.status);

    return rows.map((b) => ({
      ...b,
      stats: countsFor(stats.filter((s) => s.broadcastId === b.id)),
    }));
  }

  async get(broadcastId: string) {
    const broadcast = await this.getRow(broadcastId);
    const stats = await this.db
      .select({ status: schema.broadcastRecipient.status, count: sql<string>`count(*)` })
      .from(schema.broadcastRecipient)
      .where(
        and(
          eq(schema.broadcastRecipient.orgId, this.cfg.defaultOrgId),
          eq(schema.broadcastRecipient.broadcastId, broadcastId),
        ),
      )
      .groupBy(schema.broadcastRecipient.status);

    return { ...broadcast, stats: countsFor(stats) };
  }

  private async markRecipient(recipientId: string, status: string, reason?: string) {
    await this.db
      .update(schema.broadcastRecipient)
      .set({ status, reason, sentAt: status === "sent" ? new Date() : undefined })
      .where(eq(schema.broadcastRecipient.id, recipientId));
  }

  private async getRow(broadcastId: string) {
    const rows = await this.db
      .select()
      .from(schema.broadcast)
      .where(and(eq(schema.broadcast.orgId, this.cfg.defaultOrgId), eq(schema.broadcast.id, broadcastId)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException(`рассылка ${broadcastId} не найдена`);
    return row;
  }
}

function countsFor(rows: { status: string; count: string }[]) {
  const stats = { pending: 0, sent: 0, failed: 0, skipped: 0, total: 0 };
  for (const r of rows) {
    const n = Number(r.count);
    if (r.status in stats) stats[r.status as keyof typeof stats] = n;
    stats.total += n;
  }
  return stats;
}

import { Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@vpn/db";
import { safeCompare } from "@vpn/core-kit";
import { DB } from "../db/db.module.js";
import { loadConfig } from "../config.js";
import { NodeStateService } from "./node-state.service.js";

export interface EnrollInput {
  nodeId?: string;
  bootstrapToken?: string;
  /** Публичная половина Reality-ключа ноды. Приватная не приходит сюда никогда. */
  realityPublicKey?: string;
  shortIds?: string[];
  agentVersion?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_BYTES = 32;

/**
 * Идентичность ноды: выпуск одноразового bootstrap-токена, энроллмент агента и
 * проверка per-node токена.
 *
 * Зачем per-node секрет. Ноды стоят у разных хостеров и в РФ, изъятие одной —
 * рабочий сценарий. С общим токеном изъятая нода отдавала бы desired-state любой
 * другой: short_uuid и vless_uuid всех клиентов, адреса, ключи, — плюс позволяла
 * бы слать отчёты и статистику от чужого имени.
 *
 * Оба секрета лежат в БД только sha256-хешем: дамп базы не даёт токена.
 */
@Injectable()
export class NodeIdentityService {
  private readonly log = new Logger(NodeIdentityService.name);
  private readonly cfg = loadConfig();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly state: NodeStateService,
  ) {}

  /**
   * Выпуск bootstrap-токена. Само значение возвращается ОДИН раз — в БД уходит хеш,
   * повторно показать его неоткуда. Прежний токен той же ноды инвалидируется.
   *
   * Действующий agent-токен при этом не отзывается: нода продолжает работать, пока
   * агент не пройдёт энроллмент заново. Иначе выпуск токена «на всякий случай»
   * ронял бы живую ноду.
   */
  async issueBootstrapToken(nodeId: string) {
    const node = await this.requireNode(nodeId);
    const bootstrapToken = randomBytes(TOKEN_BYTES).toString("base64url");

    await this.db
      .insert(schema.nodeIdentity)
      .values({ nodeId, bootstrapTokenHash: sha256(bootstrapToken), bootstrapConsumedAt: null })
      .onConflictDoUpdate({
        target: schema.nodeIdentity.nodeId,
        set: { bootstrapTokenHash: sha256(bootstrapToken), bootstrapConsumedAt: null },
      });

    this.log.log(`нода ${node.name}: выпущен bootstrap-токен`);
    return { nodeId, nodeName: node.name, bootstrapToken };
  }

  /**
   * Энроллмент агента: одноразовый bootstrap-токен меняется на постоянный per-node.
   *
   * Одноразовость держится условным UPDATE (`WHERE bootstrap_consumed_at IS NULL`),
   * а не проверкой перед записью: две параллельные попытки с одним токеном иначе
   * обе прошли бы и получили разные agent-токены — второй молча затёр бы первый.
   *
   * agent_epoch инкрементится здесь же: он namespace'ит report_id статистики, и
   * переналитая нода не должна коллизиться с уже принятыми батчами прошлой
   * инкарнации.
   */
  async enroll(input: EnrollInput) {
    const nodeId = input.nodeId ?? "";
    const bootstrapToken = input.bootstrapToken ?? "";
    if (!UUID_RE.test(nodeId) || !bootstrapToken) {
      throw new UnauthorizedException("энроллмент: нужны nodeId и bootstrapToken");
    }

    const agentToken = randomBytes(TOKEN_BYTES).toString("base64url");
    const now = new Date();

    const [enrolled] = await this.db
      .update(schema.nodeIdentity)
      .set({
        agentTokenHash: sha256(agentToken),
        agentTokenIssuedAt: now,
        bootstrapConsumedAt: now,
        enrolledAt: now,
        agentEpoch: sql`${schema.nodeIdentity.agentEpoch} + 1`,
      })
      .where(
        and(
          eq(schema.nodeIdentity.nodeId, nodeId),
          eq(schema.nodeIdentity.bootstrapTokenHash, sha256(bootstrapToken)),
          isNull(schema.nodeIdentity.bootstrapConsumedAt),
        ),
      )
      .returning();

    if (!enrolled) throw new UnauthorizedException("bootstrap-токен недействителен или уже использован");

    // Reality-идентичность и пересборка идут ПОСЛЕ выдачи токена и не роняют
    // энроллмент: bootstrap уже сожжён, и 500 здесь оставил бы ноду без доступа
    // навсегда. Конфиг дособерётся ближайшим rebuild (в т.ч. sweep-джобой).
    try {
      await this.applyRealityIdentity(nodeId, input);
      await this.state.rebuild(nodeId);
    } catch (err) {
      this.log.error(
        `нода ${nodeId}: энроллмент прошёл, но пересборка конфига не удалась — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.log.log(`нода ${nodeId}: энроллмент выполнен, agent_epoch=${enrolled.agentEpoch}`);
    return { nodeId, agentToken, agentEpoch: enrolled.agentEpoch };
  }

  /**
   * Аутентификация агента по КОНКРЕТНОЙ ноде: токен ноды A не открывает ноду B.
   *
   * Общий AGENT_TOKEN остаётся переходным fallback'ом для парка, который ещё не
   * прошёл энроллмент. Но у ноды с выданным per-node токеном общий НЕ принимается —
   * иначе энроллмент не давал бы ничего.
   */
  async assertAgent(nodeId: string, token: string | undefined) {
    if (!token || !UUID_RE.test(nodeId)) throw new UnauthorizedException("невалидный agent token");

    const [identity] = await this.db
      .select({ agentTokenHash: schema.nodeIdentity.agentTokenHash })
      .from(schema.nodeIdentity)
      .where(eq(schema.nodeIdentity.nodeId, nodeId))
      .limit(1);

    if (identity?.agentTokenHash) {
      if (!safeCompare(sha256(token), identity.agentTokenHash)) {
        throw new UnauthorizedException("невалидный agent token");
      }
      return;
    }

    if (!this.cfg.agentToken || !safeCompare(token, this.cfg.agentToken)) {
      throw new UnauthorizedException("невалидный agent token");
    }
  }

  /**
   * Публичная часть Reality приезжает с ноды: приватник её никогда не покидает,
   * поэтому до энроллмента панель не знает ни pbk, ни shortIds и не может собрать
   * клиентский конфиг.
   */
  private async applyRealityIdentity(nodeId: string, input: EnrollInput) {
    if (!input.realityPublicKey) return;
    const [node] = await this.db
      .select({ configProfileId: schema.node.configProfileId })
      .from(schema.node)
      .where(eq(schema.node.id, nodeId))
      .limit(1);
    if (!node) return;

    const shortIds = (input.shortIds ?? []).filter((s) => typeof s === "string" && s.length > 0);
    await this.db
      .update(schema.inbound)
      .set({
        realityPublicKey: input.realityPublicKey,
        // пустой список с ноды не затирает уже настроенные shortIds
        ...(shortIds.length > 0 ? { shortIds } : {}),
      })
      .where(
        and(
          eq(schema.inbound.configProfileId, node.configProfileId),
          eq(schema.inbound.security, "reality"),
        ),
      );
  }

  private async requireNode(nodeId: string) {
    if (!UUID_RE.test(nodeId)) throw new NotFoundException(`нода ${nodeId} не найдена`);
    const [node] = await this.db
      .select({ id: schema.node.id, name: schema.node.name })
      .from(schema.node)
      .where(and(eq(schema.node.orgId, this.cfg.defaultOrgId), eq(schema.node.id, nodeId)))
      .limit(1);
    if (!node) throw new NotFoundException(`нода ${nodeId} не найдена`);
    return node;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

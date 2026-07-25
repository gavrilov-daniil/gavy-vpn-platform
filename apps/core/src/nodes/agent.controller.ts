import { Body, Controller, Get, Headers, Param, Post, UnauthorizedException } from "@nestjs/common";
import { NodeStateService } from "./node-state.service.js";
import { StatsService, type StatsBatch } from "./stats.service.js";
import { loadConfig } from "../config.js";

/**
 * API для node-agent. Агент ходит СЮДА сам (dial-out): ноде нужен только исходящий 443,
 * входящий control-порт на ноде не открывается, и панель не обязана знать её адрес.
 * Если панель лежит — агент продолжает крутить последний конфиг и копит статистику.
 */
@Controller("internal/agent")
export class AgentController {
  private readonly cfg = loadConfig();

  constructor(
    private readonly state: NodeStateService,
    private readonly stats: StatsService,
  ) {}

  /** Полная декларация желаемого состояния. Агент сверяет config_hash и применяет только при отличии. */
  @Get("nodes/:nodeId/desired-state")
  async desiredState(@Param("nodeId") nodeId: string, @Headers("x-agent-token") token: string) {
    this.assertToken(token);
    const state = await this.state.getDesiredState(nodeId);
    return {
      version: state.version,
      configHash: state.configHash,
      config: state.config,
      users: state.users,
      generatedAt: state.generatedAt,
    };
  }

  @Post("nodes/:nodeId/report")
  async report(
    @Param("nodeId") nodeId: string,
    @Headers("x-agent-token") token: string,
    @Body()
    body: {
      appliedConfigHash?: string;
      agentVersion?: string;
      xrayVersion?: string;
      sysStats?: Record<string, unknown>;
      egressHealth?: Record<string, unknown>;
    },
  ) {
    this.assertToken(token);
    return this.state.report(nodeId, body);
  }

  /** Приём батча статистики. Ответ с accepted=false означает «уже принято», агент дропает буфер. */
  @Post("nodes/:nodeId/stats")
  async ingestStats(
    @Param("nodeId") nodeId: string,
    @Headers("x-agent-token") token: string,
    @Body() body: StatsBatch,
  ) {
    this.assertToken(token);
    return this.stats.ingest(nodeId, body);
  }

  private assertToken(token: string | undefined) {
    // MVP-аутентификация агента. Полноценный mTLS + подпись desired-state — следующий шаг.
    if (!this.cfg.agentToken || token !== this.cfg.agentToken) {
      throw new UnauthorizedException("невалидный agent token");
    }
  }
}

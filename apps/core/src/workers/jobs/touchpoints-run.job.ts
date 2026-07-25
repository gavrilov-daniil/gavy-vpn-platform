import { Injectable } from "@nestjs/common";
import { TouchpointService } from "../../broadcast/touchpoint.service.js";
import type { JobRunner } from "../job.types.js";

/** Триггерные касания. Вся логика и дедуп — в TouchpointService, здесь только вызов по расписанию. */
@Injectable()
export class TouchpointsRunJob implements JobRunner {
  readonly jobName = "touchpoints-run" as const;

  constructor(private readonly touchpoints: TouchpointService) {}

  async run() {
    return this.touchpoints.runTouchpoints();
  }
}

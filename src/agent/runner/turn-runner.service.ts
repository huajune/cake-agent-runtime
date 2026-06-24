import { Injectable } from '@nestjs/common';
import { AgentRunnerService } from '../runner.service';
import type { AgentInvokeParams, AgentRunResult, AgentStreamResult } from '../agent-run.types';

/**
 * Turn-level runner seam.
 *
 * Phase 0a keeps behavior unchanged: this service delegates to the existing
 * AgentRunnerService, which still owns generation, tool loop execution, and
 * turn-end lifecycle attachment. Later phases can move input/output guardrails,
 * revise handling, and TurnOutcome mapping behind this seam without changing
 * channel callers again.
 */
@Injectable()
export class TurnRunnerService {
  constructor(private readonly generator: AgentRunnerService) {}

  invoke(params: AgentInvokeParams): Promise<AgentRunResult> {
    return this.generator.invoke(params);
  }

  stream(
    params: AgentInvokeParams & { onFinish?: (result: AgentRunResult) => Promise<void> | void },
  ): Promise<AgentStreamResult> {
    return this.generator.stream(params);
  }
}

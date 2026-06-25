import { Injectable, Logger } from '@nestjs/common';
import { CallerKind } from '@/enums/agent.enum';
import { GeneratorService } from '../generator/generator.service';
import type { AgentInvokeParams, AgentRunResult, AgentStreamResult } from '../agent-run.types';
import { isBookingGateRejectedToolCall, isShortCircuitedToolCall } from '../tool-call-analysis';
import type { TurnOutcome, TurnRequest, TurnTrigger } from './turn-runner.types';

export type {
  SessionRef,
  TurnContext,
  TurnOutcome,
  TurnRequest,
  TurnTrigger,
} from './turn-runner.types';

/** 主动回合的占位 user 文本：WECOM callerKind 下被 memory 历史覆盖，仅为满足非空入参。 */
const PROACTIVE_TRIGGER_PLACEHOLDER = '[系统主动跟进]';

/**
 * Turn-level runner seam.
 *
 * - `invoke`/`stream`：Phase 0a 薄委托，被动主链路（reply-workflow）继续用，行为不变。
 * - `runTurn`：Phase 0b/PR-E 新增的渠道无关回合编排入口。被动（inbound）与主动
 *   （proactive / reengagement 复聊）汇入同一处，产出 `TurnOutcome`（不投递）。
 *   目前 generation 仍委托 GeneratorService；output 守卫/revise 编排后续逐步移入。
 */
@Injectable()
export class TurnRunnerService {
  private readonly logger = new Logger(TurnRunnerService.name);

  constructor(private readonly generator: GeneratorService) {}

  invoke(params: AgentInvokeParams): Promise<AgentRunResult> {
    return this.generator.invoke(params);
  }

  stream(
    params: AgentInvokeParams & { onFinish?: (result: AgentRunResult) => Promise<void> | void },
  ): Promise<AgentStreamResult> {
    return this.generator.stream(params);
  }

  /**
   * 编排一个回合（渠道无关，不投递）。被动/主动复用同一接缝。
   *
   * 主动回合默认 `toolMode:'readonly'`（物理禁副作用工具）+ `deferTurnEnd`（投递成功后
   * 由调用方触发记忆收尾）。generator 抛错（含 memory 空历史）时按 `skipped` 收敛，
   * 不让 reengagement 调度因单个会话失败而崩。
   */
  async runTurn(req: TurnRequest): Promise<TurnOutcome> {
    const { sessionRef, trigger, context } = req;
    const isProactive = trigger.kind === 'proactive';
    const scenarioCode = isProactive ? trigger.scenarioCode : undefined;

    const params: AgentInvokeParams = {
      callerKind: context?.callerKind ?? CallerKind.WECOM,
      userId: sessionRef.userId,
      corpId: sessionRef.corpId,
      sessionId: sessionRef.sessionId,
      messageId: context?.messageId,
      messages:
        trigger.kind === 'inbound'
          ? [{ role: 'user', content: trigger.userMessage, imageUrls: trigger.images }]
          : [{ role: 'user', content: PROACTIVE_TRIGGER_PLACEHOLDER }],
      toolMode: req.toolMode ?? (isProactive ? 'readonly' : 'scenario'),
      proactiveDirective: isProactive ? trigger.directive : undefined,
      deferTurnEnd: true,
      contactName: context?.contactName,
      botImId: context?.botImId,
      botUserId: context?.botUserId,
      token: context?.token,
      imContactId: context?.imContactId,
      imRoomId: context?.imRoomId,
      apiType: context?.apiType,
      modelId: req.modelId,
    };

    let result: AgentRunResult;
    try {
      result = await this.generator.invoke(params);
    } catch (err) {
      this.logger.warn(
        `[runTurn] generation 失败，按 skipped 收敛: sessionId=${sessionRef.sessionId}, ` +
          `trigger=${trigger.kind}, err=${err instanceof Error ? err.message : String(err)}`,
      );
      return { kind: 'skipped', toolCalls: [], scenarioCode };
    }

    return this.toOutcome(result, trigger, sessionRef, context?.messageId);
  }

  private toOutcome(
    result: AgentRunResult,
    trigger: TurnTrigger,
    sessionRef: TurnRequest['sessionRef'],
    messageId: string | undefined,
  ): TurnOutcome {
    const toolCalls = result.toolCalls ?? [];
    const scenarioCode = trigger.kind === 'proactive' ? trigger.scenarioCode : undefined;
    const runTurnEnd = result.runTurnEnd;

    // handoff：request_handoff（工具内已 dispatch）或 booking gate hard-reject（outcome 层 dispatch）
    const requestHandoff = toolCalls.find((c) => c.toolName === 'request_handoff');
    const bookingGateReject = toolCalls.find(isBookingGateRejectedToolCall);
    const handoffCall = requestHandoff ?? bookingGateReject;
    if (handoffCall) {
      const args = handoffCall.args as { reasonCode?: unknown; reason?: unknown } | undefined;
      const result2 = handoffCall.result as { reasonCode?: unknown } | undefined;
      const reasonCode =
        (typeof args?.reasonCode === 'string' && args.reasonCode) ||
        (typeof result2?.reasonCode === 'string' && result2.reasonCode) ||
        'other';
      const turnId = messageId ?? scenarioCode ?? sessionRef.sessionId;
      return {
        kind: 'handoff',
        toolCalls,
        scenarioCode,
        runTurnEnd,
        handoff: {
          reasonCode,
          reason: typeof args?.reason === 'string' ? args.reason : undefined,
          sourceToolCall: handoffCall.toolName,
          idempotencyKey: `${sessionRef.sessionId}:handoff:${turnId}`,
          // 迁移期：request_handoff 工具内已 dispatch，outcome 层不再 dispatch
          alreadyDispatched: handoffCall.toolName === 'request_handoff',
        },
      };
    }

    const text = (result.text ?? '').trim();
    const shortCircuited = toolCalls.some(isShortCircuitedToolCall);
    if (shortCircuited || text.length === 0) {
      return { kind: 'skipped', toolCalls, scenarioCode, runTurnEnd };
    }

    return { kind: 'reply', reply: { text }, toolCalls, scenarioCode, runTurnEnd };
  }
}

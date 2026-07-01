import { Injectable, Logger } from '@nestjs/common';
import { CallerKind } from '@/enums/agent.enum';
import { GeneratorService } from '../generator/generator.service';
import type {
  GeneratorInvokeParams,
  GeneratorRunResult,
  GeneratorStreamResult,
  AgentToolCall,
} from '../generator/generator.types';
import {
  isShortCircuitedToolCall,
  isSideEffectTool,
  isToolSuccess,
} from '../generator/tool-call-analysis';
import { classifyReviewedOutcome } from './turn-outcome';
import {
  OutputGuardrailService,
  type OutputGuardDecision,
} from '../guardrail/output/output-guardrail.service';
import {
  type RiskInterceptInput,
  type PreAgentRiskPrecheckResult,
} from '../guardrail/input/risk-intercept.service';
import { InputGuardrailService } from '../guardrail/input/input-guard.service';
import type { SessionRef, TurnOutcome, TurnRequest, TurnTrigger } from './agent-runner.types';
import { TurnFinalizer } from './turn-finalizer';

export type {
  SessionRef,
  TurnContext,
  TurnOutcome,
  TurnRequest,
  TurnTrigger,
} from './agent-runner.types';
export type {
  RiskInterceptInput,
  PreAgentRiskPrecheckResult,
} from '../guardrail/input/risk-intercept.service';

/** 主动回合的占位 user 文本：WECOM callerKind 下被 memory 历史覆盖，仅为满足非空入参。 */
const PROACTIVE_TRIGGER_PLACEHOLDER = '[系统主动跟进]';

/** 未过守卫（短路/空文本）时的默认放行裁决。 */
const PASS_DECISION: OutputGuardDecision = {
  decision: 'pass',
  riskLevel: 'low',
  violations: [],
  ruleIds: [],
  blockedRuleIds: [],
};

const VISUAL_GENERATED_CONTENT_PATTERN = /^\s*\[(?:图片|表情)消息\]/;

/** 一次「已审生成」的结果：在 GeneratorRunResult 上叠加出站裁决与是否经过 revise 重写。 */
export interface ReviewedRunResult extends GeneratorRunResult {
  outputDecision: OutputGuardDecision;
  /** 是否经过一次 revise 重写（true 时 text/toolCalls 来自重写版）。 */
  revised: boolean;
}

/** 一次已审回合结果：生成结果 + 统一 outcome + agent 层 turn-end finalizer。 */
export interface ReviewedTurnRunResult extends Omit<ReviewedRunResult, 'runTurnEnd'> {
  outcome: TurnOutcome;
  turnFinalizer: TurnFinalizer;
  /** runTurnEnd 已被 turnFinalizer 接管，避免渠道层直接编排记忆收尾。 */
  runTurnEnd?: undefined;
}

/** 出站审查所需的接地/观测上下文（runner 从 TurnRequest 或调用方拼装）。 */
export interface ReviewContext {
  /** 红线（喂给 llm 档；缺省空）。 */
  redLines?: string[];
  userMessage?: string;
  chatId?: string;
  userId?: string;
  traceId?: string;
  contactName?: string;
  botImId?: string;
  botUserName?: string;
}

/**
 * Agent runner seam.
 *
 * - `invoke`/`stream`：兼容旧调用方的薄委托，直接跑 generator。
 * - `invokeReviewed`：generator → output guardrail → 必要时一次 revise。
 * - `runTurn`：渠道无关回合编排入口。被动 inbound 与主动 reengagement 汇入同一处，
 *   产出 `TurnOutcome`，runner 不负责投递。
 */
@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);

  constructor(
    private readonly generator: GeneratorService,
    private readonly outputGuard: OutputGuardrailService,
    private readonly inputGuard: InputGuardrailService,
  ) {}

  invoke(params: GeneratorInvokeParams): Promise<GeneratorRunResult> {
    return this.generator.invoke(params);
  }

  /**
   * 入站风险预检（input guardrail）薄委托。正常被动回合由 runTurn 在进入 generator 前调用，
   * 命中高置信度风险关键词即由 outcome sideEffects 统一出口触发人工介入副作用。
   *
   * 注意这只是 input 守卫的「pre-agent 拦截」一环；prompt-injection 硬化（扫注入→告警→
   * 追加 system 防护 suffix）仍在 generator 内的 PreparationService.applyInputGuard 执行。
   */
  precheckInput(input: RiskInterceptInput): Promise<PreAgentRiskPrecheckResult> {
    return this.inputGuard.precheckInputRisk(input);
  }

  /**
   * 入站风险预检 → 收口成 `TurnOutcome`（input guardrail 的**短路决策**归位到 runner，与出站
   * 守卫统一产出 `guardrail_blocked`）。
   *
   * - 命中：这里收成 `guardrail_blocked/inbound` 终态并携带 sideEffects（本轮不跑 Agent）。
   *   渠道只消费最终 outcome；副作用由 outcome commit 统一出口执行。
   * - 未命中：返回 `null`，调用方继续走正常生成。
   */
  async precheckInboundOutcome(input: RiskInterceptInput): Promise<TurnOutcome | null> {
    const decision = await this.inputGuard.evaluate(input);
    if (decision.decision === 'pass') return null;

    return {
      kind: 'guardrail_blocked',
      toolCalls: [],
      disposition: decision.disposition,
      sideEffects: decision.sideEffects,
      guardrail: {
        phase: 'inbound',
        source: 'input_guardrail',
        riskType: decision.riskType,
        riskLabel: decision.riskLabel,
        reason: decision.reason,
        reasonCode: decision.reasonCode,
        inspectedText: decision.inspectedText,
      },
    };
  }

  /**
   * 已审生成：generator.invoke → 出站守卫 → 需要时一次 revise 重写（§5.3 / §7）。
   *
   * - 短路/空文本：不过守卫，原样返回（decision='pass'）。
   * - decision='revise'：丢弃首版，带 violations + 既成副作用做 `toolMode:'none'`
   *   无工具重写；二次仍 revise 则按 §9「revise 死循环硬上限 1」收敛为 block。
   * - decision='block'：调用方据此不投递（rule 硬拦 / llm 严重违规 / 降级）。
   *
   * turn-end 语义：内部两次生成都强制 `deferTurnEnd`，确保被丢弃的首版不写记忆；最终采纳版的
   * `runTurnEnd` 按调用方意图处理——调用方原本要自动收尾（未显式 defer）时，pass 即 fire-and-forget
   * 触发、block 则丢弃（不写「对用户说过」记忆，呼应 HC-4）。
   *
   * **flag 关闭时**（默认）：守卫只跑 rule 档，decision 仅 pass / 硬 block，无重写——等价现状。
   */
  async invokeReviewed(
    params: GeneratorInvokeParams,
    ctx: ReviewContext,
  ): Promise<ReviewedRunResult> {
    const wantDefer = params.deferTurnEnd === true;
    const first = await this.generator.invoke({ ...params, deferTurnEnd: true });

    const firstText = (first.text ?? '').trim();
    const firstSkipped = (first.toolCalls ?? []).some(isShortCircuitedToolCall);
    if (!firstText || firstSkipped) {
      return this.finalizeReviewed(first, PASS_DECISION, false, wantDefer);
    }

    const decision = await this.outputGuard.check(this.buildGuardInput(first, ctx));
    if (decision.decision !== 'revise') {
      return this.finalizeReviewed(first, decision, false, wantDefer);
    }

    // revise（hard cap 1）：丢弃首版，带违规意见 + 既成副作用做无工具重写。
    const committed = this.summarizeCommittedSideEffects(first.toolCalls ?? []);
    this.logger.log(
      `[invokeReviewed] output=revise，触发一次重写: rules=${decision.ruleIds.join(',') || '-'}, ` +
        `violations=${decision.violations.map((v) => v.type).join(',') || '-'}`,
    );
    const revised = await this.generator.invoke({
      ...params,
      deferTurnEnd: true,
      toolMode: 'none',
      reviseFeedback: decision.violations,
      committedSideEffects: committed || undefined,
    });

    const revisedText = (revised.text ?? '').trim();
    if (!revisedText) {
      return this.finalizeReviewed(
        revised,
        { ...decision, decision: 'block', reasonCode: 'revise_empty' },
        true,
        wantDefer,
      );
    }

    const reviewedToolCalls = this.mergeToolCallsForRevisedResult(first, revised);
    const decision2 = await this.outputGuard.check(
      this.buildGuardInput(revised, ctx, reviewedToolCalls),
    );
    // §9：revise 死循环硬上限 1 —— 二次仍 revise 则 block。
    const finalDecision: OutputGuardDecision =
      decision2.decision === 'revise'
        ? { ...decision2, decision: 'block', reasonCode: 'revise_exhausted' }
        : decision2;
    return this.finalizeReviewed(
      { ...revised, toolCalls: reviewedToolCalls },
      finalDecision,
      true,
      wantDefer,
    );
  }

  /**
   * 渠道入站路径的已审回合入口：`invokeReviewed` + 统一 outcome 分类 + turn-end finalizer 接管。
   *
   * 渠道只需要在投递结局已知后调用 `turnFinalizer.settle({ delivered })`，不再直接持有
   * `runTurnEnd`，也不需要理解 `includeAssistantText` 这条记忆领域规则。
   */
  async invokeReviewedTurn(params: {
    invoke: GeneratorInvokeParams;
    review: ReviewContext;
    trigger: TurnTrigger;
    sessionRef: SessionRef;
    messageId?: string;
    onTurnEndError?: (error: unknown) => void;
  }): Promise<ReviewedTurnRunResult> {
    const result = await this.invokeReviewed(params.invoke, params.review);
    const outcome = classifyReviewedOutcome(
      result,
      params.trigger,
      params.sessionRef,
      params.messageId,
    );
    const turnFinalizer = TurnFinalizer.from(result.runTurnEnd, params.onTurnEndError);
    return {
      ...result,
      runTurnEnd: undefined,
      outcome: { ...outcome, runTurnEnd: undefined },
      turnFinalizer,
    };
  }

  private buildGuardInput(
    result: GeneratorRunResult,
    ctx: ReviewContext,
    toolCalls: AgentToolCall[] = result.toolCalls ?? [],
  ) {
    return {
      reply: (result.text ?? '').trim(),
      toolCalls,
      memorySnapshot: result.memorySnapshot,
      redLines: ctx.redLines ?? [],
      userMessage: ctx.userMessage,
      chatId: ctx.chatId,
      userId: ctx.userId,
      traceId: ctx.traceId,
      contactName: ctx.contactName,
      botImId: ctx.botImId,
      botUserName: ctx.botUserName,
    };
  }

  private mergeToolCallsForRevisedResult(
    draft: GeneratorRunResult,
    revised: GeneratorRunResult,
  ): AgentToolCall[] {
    return [...(draft.toolCalls ?? []), ...(revised.toolCalls ?? [])];
  }

  /** 把本轮已成功的副作用工具压成一句既成事实提示（喂给 revise 重写，防"声称未发生/重复执行"）。 */
  private summarizeCommittedSideEffects(toolCalls: AgentToolCall[]): string {
    const names = [
      ...new Set(
        toolCalls
          .filter((c) => isSideEffectTool(c.toolName) && isToolSuccess(c.result))
          .map((c) => c.toolName),
      ),
    ];
    if (names.length === 0) return '';
    return `本轮已成功执行副作用工具：${names.join('、')}（已生效不可撤销；重写时不要声称未发生，也不要重复执行）`;
  }

  private finalizeReviewed(
    result: GeneratorRunResult,
    decision: OutputGuardDecision,
    revised: boolean,
    wantDefer: boolean,
  ): ReviewedRunResult {
    const blocked = decision.decision === 'block';
    if (!wantDefer) {
      // 调用方原本要自动收尾：pass→fire-and-forget 触发；block→丢弃（不写"对用户说过"记忆）。
      if (!blocked) void result.runTurnEnd?.();
      return { ...result, runTurnEnd: undefined, outputDecision: decision, revised };
    }
    return { ...result, outputDecision: decision, revised };
  }

  stream(
    params: GeneratorInvokeParams & {
      onFinish?: (result: GeneratorRunResult) => Promise<void> | void;
    },
  ): Promise<GeneratorStreamResult> {
    return this.generator.stream(params);
  }

  /**
   * 编排一个回合（渠道无关，不投递）。被动/主动复用同一接缝。
   *
   * 主动回合默认 `toolMode:'readonly'`（物理禁副作用工具）+ `deferTurnEnd`（投递成功后
   * 由调用方触发记忆收尾）。generator 抛错（含 memory 空历史）时：**主动**回合按 `skipped`
   * 收敛（不让 reengagement 调度因单个会话失败而崩），**被动 inbound** 则抛回渠道由
   * fallback 接管（不静默吞掉候选人正在等待的回复）。
   */
  async runTurn(req: TurnRequest): Promise<TurnOutcome> {
    const { sessionRef, trigger, context } = req;
    const isProactive = trigger.kind === 'proactive';
    const scenarioCode = isProactive ? trigger.scenarioCode : undefined;

    if (trigger.kind === 'inbound') {
      const guardrailBlocked = await this.precheckInboundOutcome({
        corpId: sessionRef.corpId,
        chatId: sessionRef.sessionId,
        userId: sessionRef.userId,
        pauseTargetId: sessionRef.sessionId || sessionRef.userId,
        scanContent: this.buildInputGuardScanContent(trigger),
        messageId: context?.messageId,
        contactName: context?.contactName,
        botImId: context?.botImId,
        botUserName: context?.botUserId,
      });
      if (guardrailBlocked) return guardrailBlocked;
    }

    const params: GeneratorInvokeParams = {
      callerKind: context?.callerKind ?? CallerKind.WECOM,
      userId: sessionRef.userId,
      corpId: sessionRef.corpId,
      sessionId: sessionRef.sessionId,
      messageId: context?.messageId,
      messages:
        trigger.kind === 'inbound'
          ? [
              {
                role: 'user',
                content: trigger.userMessage,
                imageUrls: trigger.images,
                imageMessageIds: context?.imageMessageIds,
              },
            ]
          : [{ role: 'user', content: PROACTIVE_TRIGGER_PLACEHOLDER }],
      toolMode: req.toolMode ?? (isProactive ? 'readonly' : 'scenario'),
      proactiveDirective: isProactive ? trigger.directive : undefined,
      deferTurnEnd: true,
      scenario: context?.scenario,
      imageUrls: trigger.kind === 'inbound' ? trigger.images : undefined,
      imageMessageIds: context?.imageMessageIds,
      visualMessageTypes: context?.visualMessageTypes,
      contactName: context?.contactName,
      botImId: context?.botImId,
      botUserId: context?.botUserId,
      groupId: context?.groupId,
      externalUserId: context?.externalUserId,
      token: context?.token,
      imContactId: context?.imContactId,
      imRoomId: context?.imRoomId,
      apiType: context?.apiType,
      modelId: req.modelId,
      thinking: context?.thinking,
      shortTermEndTimeInclusive: context?.shortTermEndTimeInclusive,
      onPreparedRequest: context?.onPreparedRequest,
    };

    let result: ReviewedRunResult;
    try {
      result = await this.invokeReviewed(params, {
        userMessage: trigger.kind === 'inbound' ? trigger.userMessage : undefined,
        chatId: sessionRef.sessionId,
        userId: sessionRef.userId,
        traceId: context?.messageId,
        contactName: context?.contactName,
        botImId: context?.botImId,
        botUserName: context?.botUserId,
      });
    } catch (err) {
      // 韧性收敛仅对**主动**回合成立：reengagement 调度不能因单个会话生成失败（含空历史）而崩，
      // 静默放弃这一跳即可。被动 inbound 则相反——候选人正在等回复，静默吞掉 LLM/记忆故障会让
      // 用户悬空且无人接手，必须把异常抛回渠道，由渠道 fallback/失败流水接管。
      this.logger.warn(
        `[runTurn] generation 失败: sessionId=${sessionRef.sessionId}, trigger=${trigger.kind}, ` +
          `err=${err instanceof Error ? err.message : String(err)}`,
      );
      if (isProactive) {
        return { kind: 'skipped', toolCalls: [], scenarioCode };
      }
      throw err;
    }

    // 终态分类与渠道共享同一处纯函数（classifyReviewedOutcome）：block→guardrail_blocked/outbound、
    // committed handoff / booking gate→handoff、短路/空文本→skipped、其余→reply。
    const outcome = classifyReviewedOutcome(result, trigger, sessionRef, context?.messageId);
    if (outcome.kind === 'guardrail_blocked' && outcome.guardrail?.phase === 'outbound') {
      this.logger.warn(
        `[runTurn] 出站守卫拦截: sessionId=${sessionRef.sessionId}, ` +
          `rules=${result.outputDecision.blockedRuleIds.join(',') || '-'}, ` +
          `reason=${result.outputDecision.reasonCode ?? '-'}`,
      );
    }
    return outcome;
  }

  private buildInputGuardScanContent(trigger: TurnTrigger): string {
    if (trigger.kind !== 'inbound') return '';
    const content = trigger.userMessage?.trim() ?? '';
    if (!content) return '';

    const textLines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !VISUAL_GENERATED_CONTENT_PATTERN.test(line));

    return textLines.join('\n');
  }
}

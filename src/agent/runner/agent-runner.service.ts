import { Injectable, Logger } from '@nestjs/common';
import { CallerKind } from '@/enums/agent.enum';
import { GeneratorService } from '../generator/generator.service';
import type {
  AgentInvokeParams as GeneratorInvokeParams,
  AgentRunResult as GeneratorRunResult,
  AgentStreamResult as GeneratorStreamResult,
  AgentToolCall,
} from '../agent-run.types';
import { isShortCircuitedToolCall, isToolSuccess, SIDE_EFFECT_TOOLS } from '../tool-call-analysis';
import type {
  GuardrailReviewStepTrace,
  GuardrailTurnTrace,
} from '@shared-types/guardrail.contract';
import { classifyReviewedOutcome } from './turn-outcome';
import {
  OutputGuardrailService,
  type OutputGuardDecision,
} from '../guardrail/output/output-guardrail.service';
import {
  RiskInterceptService,
  type RiskInterceptInput,
  type PreAgentRiskPrecheckResult,
} from '../guardrail/input/risk-intercept.service';
import type { TurnOutcome, TurnRequest } from './agent-runner.types';

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
  repairMode: 'rewrite',
};

/** 一次「已审生成」的结果：在 GeneratorRunResult 上叠加出站裁决与是否经过 revise 重写。 */
export interface ReviewedRunResult extends GeneratorRunResult {
  outputDecision: OutputGuardDecision;
  /** 是否经过一次 revise 重写（true 时 text/toolCalls 来自重写版）。 */
  revised: boolean;
  /**
   * 出站守卫全程 trace（首审→repair→二审），供流水落库与调试页展示。
   * 短路/空文本未过守卫时为 undefined。
   */
  guardrailTrace?: GuardrailTurnTrace;
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
 * - `invokeReviewed`：generator → output guardrail → 必要时一次受控 repair。
 * - `runTurn`：渠道无关回合编排入口。被动 inbound 与主动 reengagement 汇入同一处，
 *   产出 `TurnOutcome`，runner 不负责投递。
 */
@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);

  constructor(
    private readonly generator: GeneratorService,
    private readonly outputGuard: OutputGuardrailService,
    private readonly inputRiskGuard: RiskInterceptService,
  ) {}

  invoke(params: GeneratorInvokeParams): Promise<GeneratorRunResult> {
    return this.generator.invoke(params);
  }

  /**
   * 入站风险预检（input guardrail）。被动渠道在生成前调用一次：命中高置信度风险关键词
   * 即同步触发人工介入副作用（暂停托管 + 飞书告警，fire-and-forget）并返回 `{ hit: true }`。
   * 本方法只产出风险信号 + 触发介入副作用，**是否短路本轮**由调用渠道按 `hit` 决定（当前
   * WeCom 入站命中即静默并转人工，不再跑 Agent）。
   *
   * 注意这只是 input 守卫的「pre-agent 拦截」一环；prompt-injection 硬化（扫注入→告警→
   * 追加 system 防护 suffix）仍在 generator 内的 PreparationService.applyInputGuard 执行，
   * 不经此入口。
   *
   * 渠道侧只负责把入站 DTO 解析成中立 `RiskInterceptInput`（依赖倒置，DTO/parser 留渠道），
   * pre-agent 拦截的「何时调、调哪个守卫」编排权收敛在 runner，与出站守卫（invokeReviewed）
   * 对称——渠道不再直接注入 `RiskInterceptService`。
   */
  precheckInput(input: RiskInterceptInput): Promise<PreAgentRiskPrecheckResult> {
    return this.inputRiskGuard.precheck(input);
  }

  /**
   * 入站风险预检 → 收口成 `TurnOutcome`（input guardrail 的**短路决策**归位到 runner，与出站
   * 守卫产出 `blocked`/`handoff` 对称）。
   *
   * - 命中：guardrail 内部已 fire-and-forget dispatch 人工介入（暂停托管 + 飞书告警），这里收成
   *   `intercepted` 终态（本轮不跑 Agent）。渠道只负责静默收尾（记跳过观测/去重/ack），不再自己
   *   判断「hit 了该怎么办」。
   * - 未命中：返回 `null`，调用方继续走正常生成。
   */
  async precheckInboundOutcome(input: RiskInterceptInput): Promise<TurnOutcome | null> {
    const result = await this.inputRiskGuard.precheck(input);
    if (!result.hit) return null;
    return {
      kind: 'intercepted',
      toolCalls: [],
      intercept: {
        riskType: result.riskType,
        label: result.label,
        reason: result.reason,
      },
    };
  }

  /**
   * 已审生成：generator.invoke → 出站守卫 → 需要时一次受控 repair（§5.3 / §7）。
   *
   * - 短路/空文本：不过守卫，原样返回（decision='pass'）。
   * - decision='revise'：丢弃首版，带 violations + 既成副作用做 `toolMode:'none'` 无工具重写；
   * - decision='replan'：丢弃首版，带 violations + 既成副作用做 `toolMode:'readonly'`
   *   允许只读工具重新规划；
   *   再审一次；二次仍 revise/replan 则按 §9「repair 死循环硬上限 1」收敛为 block。
   * - decision='block'：调用方据此不投递（rule 硬拦 / llm 严重违规 / 降级）。
   *
   * turn-end 语义：内部两次生成都强制 `deferTurnEnd`，确保被丢弃的首版不写记忆；最终采纳版的
   * `runTurnEnd` 按调用方意图处理——调用方原本要自动收尾（未显式 defer）时，pass 即 fire-and-forget
   * 触发、block 则丢弃（不写「对用户说过」记忆，呼应 HC-4）。
   *
   * **flag 关闭时**（默认）：守卫只跑 rule 档；可恢复 veto 会先进一次受控 repair。
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
    const firstStep = this.toGuardrailStep('first', decision);
    const shouldRepair = decision.decision === 'revise' || decision.decision === 'replan';
    if (!shouldRepair) {
      return this.finalizeReviewed(
        first,
        decision,
        false,
        wantDefer,
        this.buildGuardrailTrace([firstStep], false, decision),
      );
    }

    // repair（hard cap 1）：丢弃首版，带违规意见 + 既成副作用做受控修复。
    const committed = this.summarizeCommittedSideEffects(first.toolCalls ?? []);
    this.logger.log(
      `[invokeReviewed] output=${decision.decision}，触发一次受控修复: rules=${decision.ruleIds.join(',') || '-'}, ` +
        `violations=${decision.violations.map((v) => v.type).join(',') || '-'}`,
    );
    const revised = await this.generator.invoke({
      ...params,
      deferTurnEnd: true,
      toolMode: decision.repairMode === 'replan' ? 'readonly' : 'none',
      reviseFeedback: decision.violations,
      guardrailRepair:
        decision.repairMode === 'rewrite'
          ? {
              originalReply: firstText,
              ruleIds: decision.ruleIds,
              feedbackToGenerator: decision.feedbackToGenerator,
            }
          : undefined,
      committedSideEffects: committed || undefined,
    });

    const revisedText = (revised.text ?? '').trim();
    if (!revisedText) {
      const emptyDecision: OutputGuardDecision = {
        ...decision,
        decision: 'block',
        reasonCode: 'revise_empty',
      };
      return this.finalizeReviewed(
        revised,
        emptyDecision,
        true,
        wantDefer,
        this.buildGuardrailTrace([firstStep], true, emptyDecision),
      );
    }

    const reviewedToolCalls = this.mergeToolCallsForRevisedResult(first, revised);
    const decision2 = await this.outputGuard.check(
      this.buildGuardInput(revised, ctx, reviewedToolCalls),
    );
    // §9：repair 死循环硬上限 1 —— 二次仍 revise/replan 则 block。
    const finalDecision: OutputGuardDecision =
      decision2.decision === 'revise' || decision2.decision === 'replan'
        ? { ...decision2, decision: 'block', reasonCode: 'repair_exhausted' }
        : decision2;
    return this.finalizeReviewed(
      { ...revised, toolCalls: reviewedToolCalls },
      finalDecision,
      true,
      wantDefer,
      this.buildGuardrailTrace(
        [firstStep, this.toGuardrailStep('revised', decision2)],
        true,
        finalDecision,
      ),
    );
  }

  /** 把一次出站裁决压成紧凑 trace step（不带证据全文，落库体积可控）。 */
  private toGuardrailStep(
    stage: GuardrailReviewStepTrace['stage'],
    decision: OutputGuardDecision,
  ): GuardrailReviewStepTrace {
    return {
      stage,
      decision: decision.decision,
      riskLevel: decision.riskLevel,
      ruleIds: decision.ruleIds,
      blockedRuleIds: decision.blockedRuleIds,
      violationTypes: decision.violations.map((v) => v.type),
      repairMode: decision.repairMode,
      reasonCode: decision.reasonCode,
    };
  }

  private buildGuardrailTrace(
    steps: GuardrailReviewStepTrace[],
    repaired: boolean,
    finalDecision: OutputGuardDecision,
  ): GuardrailTurnTrace {
    return {
      steps,
      repaired,
      finalDecision: finalDecision.decision,
      reasonCode: finalDecision.reasonCode,
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
          .filter((c) => SIDE_EFFECT_TOOLS.has(c.toolName) && isToolSuccess(c.result))
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
    guardrailTrace?: GuardrailTurnTrace,
  ): ReviewedRunResult {
    const blocked = decision.decision === 'block';
    if (!wantDefer) {
      // 调用方原本要自动收尾：pass→fire-and-forget 触发；block→只记用户侧
      // （不投影助手轮次，不写"对用户说过"记忆，但保留本轮用户事实提取）。
      void result.runTurnEnd?.(blocked ? { includeAssistantText: false } : undefined);
      return {
        ...result,
        runTurnEnd: undefined,
        outputDecision: decision,
        revised,
        guardrailTrace,
      };
    }
    return { ...result, outputDecision: decision, revised, guardrailTrace };
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

    const params: GeneratorInvokeParams = {
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

    // 终态分类与渠道共享同一处纯函数（classifyReviewedOutcome）：block→blocked、
    // committed handoff / booking gate→handoff、短路/空文本→skipped、其余→reply。
    const outcome = classifyReviewedOutcome(result, trigger, sessionRef, context?.messageId);
    if (outcome.kind === 'blocked') {
      this.logger.warn(
        `[runTurn] 出站守卫拦截: sessionId=${sessionRef.sessionId}, ` +
          `rules=${result.outputDecision.blockedRuleIds.join(',') || '-'}, ` +
          `reason=${result.outputDecision.reasonCode ?? '-'}`,
      );
    }
    return outcome;
  }
}

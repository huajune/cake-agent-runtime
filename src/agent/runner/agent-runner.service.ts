import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { CallerKind } from '@/enums/agent.enum';
import { GeneratorAgent } from '../generator/generator.agent';
import type {
  GeneratorInvokeParams as GeneratorInvokeParams,
  GeneratorRunResult,
  GeneratorStreamResult,
  AgentToolCall,
} from '../generator/generator.types';
import {
  isShortCircuitedToolCall,
  isSideEffectTool,
  isToolSuccess,
} from '../generator/tool-call-analysis';
import {
  GUARDRAIL_REPAIR_MODE,
  type GuardrailReviewStepTrace,
  type GuardrailTurnTrace,
  type OutputResolution,
} from '@shared-types/guardrail.contract';
import { GuardrailReviewService } from '@biz/message/services/guardrail-review.service';
import type {
  GuardrailReviewInsertInput,
  GuardrailReviewStepDetail,
} from '@biz/message/types/guardrail-review.types';
import { classifyReviewedOutcome, resolveReviewedResolution } from './turn-outcome';
import { isDanglingCheckReply } from './dangling-reply';
import {
  detectOutputLeak,
  hasTechnicalDocumentationShape,
  isInternalReasoningArtifactOnly,
  isToolCallArtifactOnly,
  stripInternalReasoningArtifacts,
  stripMarkdownCodeFences,
  tryUnwrapEnvelopeReply,
} from '../guardrail/output/rules/internal-info-leaks.rule';
import { OutboundReplySanitizer } from '../guardrail/output/sanitizer/outbound-reply-sanitizer';
import { detectRepairRegression } from '../reply-repair/repair-regression.util';
import {
  OutputGuardrailService,
  type OutputGuardDecision,
} from '../guardrail/output/output-guardrail.service';
import {
  type RiskInterceptInput,
  type PreAgentRiskPrecheckResult,
} from '../guardrail/input/risk-intercept.service';
import { InputGuardrailService } from '../guardrail/input/input-guard.service';
import type { InboundTurnRequest, SessionRef, TurnOutcome } from './agent-runner.types';
import { TurnFinalizer } from './turn-finalizer';
import { AgentTracerService } from '@observability/agent-tracer.service';
import { RequestContextService } from '@observability/context/request-context.service';
import { ReplyRepairAgent } from '../reply-repair/reply-repair.agent';
import {
  ReplyRepairContextProvider,
  type ReplyRepairContext,
} from '../reply-repair/reply-repair-context.provider';

export type {
  SessionRef,
  TurnContext,
  InboundTurnRequest,
  TurnOutcome,
} from './agent-runner.types';
export type {
  RiskInterceptInput,
  PreAgentRiskPrecheckResult,
} from '../guardrail/input/risk-intercept.service';

/** 未过守卫（短路/空文本）时的默认放行裁决。 */
const PASS_DECISION: OutputGuardDecision = {
  decision: 'pass',
  riskLevel: 'low',
  violations: [],
  ruleIds: [],
  blockedRuleIds: [],
  repairMode: 'rewrite',
};

const VISUAL_GENERATED_CONTENT_PATTERN = /^\s*\[(?:图片|表情)消息\]/;

/** 一次「已审生成」的结果：在 GeneratorRunResult 上叠加出站裁决与是否经过 repair 重写。 */
export interface ReviewedRunResult extends GeneratorRunResult {
  /** 被采用文本所对应的真实审查意见，不用最终处置覆盖它。 */
  outputDecision: OutputGuardDecision;
  resolution: OutputResolution;
  /** 是否经过一次 repair 重写（true 时 text/toolCalls 来自重写版）。 */
  revised: boolean;
  /**
   * 出站守卫全程 trace（首审→repair→二审），供流水落库与调试页展示。
   * 短路/空文本未过守卫时为 undefined。
   */
  guardrailTrace?: GuardrailTurnTrace;
}

/** 一次已审回合结果：生成结果 + 统一 outcome + agent 层 turn-end finalizer。 */
export interface ReviewedTurnRunResult extends Omit<ReviewedRunResult, 'runTurnEnd'> {
  outcome: TurnOutcome;
  turnFinalizer: TurnFinalizer;
  /** runTurnEnd 已被 turnFinalizer 接管，避免渠道层直接编排记忆收尾。 */
  runTurnEnd?: undefined;
}

/** 出站审查所需的接地/观测上下文（runner 从 InboundTurnRequest 或调用方拼装）。 */
export interface ReviewContext {
  /** 红线（喂给 llm 档；缺省空）。 */
  redLines?: string[];
  sessionRef?: SessionRef;
  userMessage?: string;
  chatId?: string;
  userId?: string;
  traceId?: string;
  contactName?: string;
  botImId?: string;
  botUserName?: string;
  shortTermEndTimeInclusive?: number;
}

/**
 * Agent runner seam.
 *
 * - `invoke`/`stream`：兼容旧调用方的薄委托，直接跑 generator。
 * - `invokeReviewed`：generator → output guardrail → 必要时一次受控 repair。
 * - `runInboundTurn`：渠道无关的被动入站回合编排入口，产出 `TurnOutcome`，runner 不负责投递。
 *
 * 主动复聊由 reengagement 域的专用 Agent 承载，不进入本 Runner。
 */
@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);

  constructor(
    private readonly generator: GeneratorAgent,
    private readonly outputGuard: OutputGuardrailService,
    private readonly inputGuard: InputGuardrailService,
    private readonly guardrailReviews: GuardrailReviewService,
    private readonly replyRepairAgent: ReplyRepairAgent,
    @Optional()
    private readonly replyRepairContextProvider?: ReplyRepairContextProvider,
    @Optional()
    private readonly requestContext?: RequestContextService,
    @Optional()
    private readonly tracer?: AgentTracerService,
  ) {}

  invoke(params: GeneratorInvokeParams): Promise<GeneratorRunResult> {
    return this.generator.invoke(params);
  }

  /**
   * 入站风险预检（input guardrail）的薄封装：命中高置信度风险关键词即返回
   * `{ hit: true }` + 风险归因。当前无生产调用方——渠道走 runInboundTurn，内部经
   * precheckInboundOutcome 完成入站预检。守卫本身**只判定不执行副作用**——人工介入
   * （暂停托管 + 飞书告警）以 sideEffect intent 挂在 outcome 上，由渠道在 replay 定局后
   * 经 TurnOutcomeInterventionService.commit 统一出口执行，避免被 replay 丢弃的首版
   * 误触发暂停/告警。
   *
   * 注意这只是 input 守卫的「pre-agent 拦截」一环；prompt-injection 硬化（扫注入→告警→
   * 追加 system 防护 section）由 PromptInjectionDetector + PromptSecurityObserverService
   * 在 preparation 阶段执行，不经此入口。
   *
   * 渠道侧只负责把入站 DTO 解析成中立 `RiskInterceptInput`（依赖倒置，DTO/parser 留渠道），
   * pre-agent 拦截的「何时调、调哪个守卫」编排权收敛在 runner，与出站守卫（invokeReviewed）
   * 对称。
   */
  precheckInput(input: RiskInterceptInput): Promise<PreAgentRiskPrecheckResult> {
    return this.inputGuard.precheckInputRisk(input);
  }

  /**
   * 入站风险预检 → 收口成 `handoff`；来源和风险原因保留在 guardrail，
   * 继续沿用 conversation_risk 意图，不再生成普通转人工意图。
   *
   * - 命中：这里收成 `handoff` 终态并携带 sideEffects（本轮不跑 Agent），
   *   由渠道在 replay 定局后经 TurnOutcomeInterventionService.commit 统一执行副作用。
   *   渠道只负责静默收尾（commit 副作用/记跳过观测/去重/ack）。
   * - 未命中：返回 `null`，调用方继续走正常生成。
   */
  async precheckInboundOutcome(input: RiskInterceptInput): Promise<TurnOutcome | null> {
    const decision = await this.inputGuard.evaluate(input);
    if (decision.decision === 'pass') return null;

    // 观测 P1-2：入站拦截此前零事件，时间线上看不出"这轮为什么没跑 Agent"。
    this.tracer?.emit({
      type: 'inbound_guardrail_handoff',
      reasonCode: decision.reasonCode,
      riskType: decision.riskType,
      riskLabel: decision.riskLabel,
    });

    return {
      kind: 'handoff',
      toolCalls: [],
      disposition: decision.disposition,
      guardrail: {
        phase: 'inbound',
        source: 'input_guardrail',
        riskType: decision.riskType,
        riskLabel: decision.riskLabel,
        reason: decision.reason,
        reasonCode: decision.reasonCode,
        inspectedText: decision.inspectedText,
      },
      sideEffects: decision.sideEffects,
    };
  }

  /**
   * 已审生成：generator.invoke → 出站守卫 → 需要时一次受控 repair（§5.3 / §7）。
   *
   * - 短路/空文本：不过守卫，原样返回（decision='pass'）。
   * - decision='repair'：丢弃首版，交给独立 ReplyRepairAgent 按 violations + 已知事实做文本修复；
   *   再审一次；二次仍不过按 §9「repair 死循环硬上限 1」分级收敛。
   * - decision='replan'（守卫派生 repairMode=replan）：首版整体作废，用完全相同的参数
   *   重进一次 generator，重生成结果按修复版走二审与回归闸；首版永不回退、二审不 fail-open，
   *   仍不过则 `replan_exhausted` 转人工。
   * - 无法安全放行：Runner 产出 handoff；有意静默产出 skipped，审查意见保持原样。
   *
   * turn-end 语义：生成结果上的 `runTurnEnd` 一律原样透传给调用方（repair 产物复用首版的
   * 闭包），由调用方在投递结局已知后触发一次——被丢弃的首版因此不会写记忆。
   *
   * **flag 关闭时**（默认）：守卫只跑 rule 档；可恢复 veto 会先进一次受控 repair。
   */
  async invokeReviewed(
    params: GeneratorInvokeParams,
    ctx: ReviewContext,
  ): Promise<ReviewedRunResult> {
    const first = await this.generator.invoke(params);

    // 审查前先剥模型模仿输出的 `[消息发送时间：…]` 标记，避免噪声进入 LLM 审查
    // 上下文与守卫档案。只剥时间标记，不跑完整 sanitize——后者会剥
    // 反引号，破坏 internal_output_leak 的围栏检测。投递文本另由 turn-outcome 统一清洗。
    let firstText = OutboundReplySanitizer.stripTimeMarkers((first.text ?? '').trim());
    const firstSkipped = (first.toolCalls ?? []).some(isShortCircuitedToolCall);
    if (!firstText || firstSkipped) {
      return this.finalizeReviewed(first, PASS_DECISION, { outcome: 'skipped' }, false);
    }

    const decision = await this.outputGuard.check(this.buildGuardInput(first, ctx));
    if (decision.deterministicReply !== undefined) {
      first.text = decision.deterministicReply;
      firstText = OutboundReplySanitizer.stripTimeMarkers(decision.deterministicReply.trim());
      const originalRunTurnEnd = first.runTurnEnd;
      if (originalRunTurnEnd) {
        first.runTurnEnd = (options) =>
          originalRunTurnEnd({
            ...options,
            assistantTextOverride:
              options && 'assistantTextOverride' in options
                ? options.assistantTextOverride
                : decision.deterministicReply,
          });
      }
    }
    const firstStep = this.toGuardrailStep('first', decision);

    // 首版无可采用正文：元叙述保留有意静默；纯内部产物直接转人工，不进入修复。
    const silenceReason = this.resolveDirectSilenceReason(decision, firstText);
    if (silenceReason) {
      const resolution: OutputResolution = {
        outcome: silenceReason === 'meta_narration_silenced' ? 'skipped' : 'handoff',
        source: 'output_guardrail',
        reasonCode: silenceReason,
      };
      this.logger.warn(
        `[invokeReviewed] 首版命中直达静默（${silenceReason}），结束自动回复（${resolution.outcome}）: ` +
          `text="${firstText.slice(0, 80)}"`,
      );
      this.persistReviewRecord(ctx, {
        result: first,
        firstReply: firstText,
        firstDecision: decision,
        resolution,
        repaired: false,
      });
      return this.finalizeReviewed(
        first,
        decision,
        resolution,
        false,
        this.buildGuardrailTrace([firstStep], false, resolution),
      );
    }

    const shouldRepair = decision.decision !== 'pass' && decision.decision !== 'observe';
    if (!shouldRepair) {
      const resolution: OutputResolution = { outcome: 'reply', reasonCode: decision.reasonCode };
      this.persistReviewRecord(ctx, {
        result: first,
        firstReply: firstText,
        firstDecision: decision,
        resolution,
        repaired: false,
      });
      return this.finalizeReviewed(
        first,
        decision,
        resolution,
        false,
        this.buildGuardrailTrace([firstStep], false, resolution),
      );
    }

    // 修复方式由守卫按规则 action 派生，runner 只执行：
    // - rewrite：ReplyRepairAgent 无工具局部重写；
    // - replan：首版整体作废，用完全相同的 params 重进一次 generator——不注入守卫反馈、
    //   不裁工具集（2026-07 旧实现的两处要害偏差，07-27 已删，不得复活），重生成结果按修复版
    //   走二审与回归闸。
    // 执行层唯一的守门：首版已提交副作用（booking/拉群等）时不得重进 generator，否则会重复
    // 执行；此时降级为 rewrite 并告警——replan 档规则按定义只在零工具轮命中，走到这里即规则漂移。
    const committed = this.summarizeCommittedSideEffects(first.toolCalls ?? []);
    const replanRequested = decision.repairMode === GUARDRAIL_REPAIR_MODE.REPLAN;
    const replan = replanRequested && committed === '';
    if (replanRequested && !replan) {
      this.logger.warn(
        `[invokeReviewed] 守卫要求 replan 但首版已提交副作用，降级为 rewrite: ` +
          `rules=${decision.ruleIds.join(',') || '-'}, committed="${committed}", traceId=${ctx.traceId ?? '-'}`,
      );
    }
    // 首版可否 fail-open（回退首版/放行首版）：replan 档的首版整体作废，一律不可。
    const firstFailOpenEligible = !replan && this.isFirstReplyFailOpenEligible(decision);

    // 确定性修复快通道：仅命中 internal_output_leak 且剥掉代码围栏标记后不再有任何
    // 泄漏形态时，剥离本身就是完整修复——围栏内正文（报名表模板等结构化内容）逐字保留，
    // 跳过 LLM 重写，避免结构化正文被压缩成一句话。
    // 剥离产物仍走下方二审，二审才是放行依据。replan 轮不走任何剥离快通道。
    const reasoningStrippedText = replan
      ? null
      : this.tryStripInternalReasoningLeak(decision, firstText);
    const fenceStrippedText =
      reasoningStrippedText === null && !replan
        ? this.tryStripFenceOnlyLeak(decision, firstText)
        : null;
    // 第二条确定性快通道：JSON 信封拆封。模型把完整正文包进
    // `{"agent_response":"…"}` 类信封时，直接拆封可避免把合法正文当成残文静默。拆封
    // 产物与剥围栏同样走二审 + 悬空检测。
    const envelopeUnwrappedText =
      reasoningStrippedText === null && fenceStrippedText === null && !replan
        ? this.tryUnwrapEnvelopeLeak(decision, firstText)
        : null;
    const deterministicRepairText =
      reasoningStrippedText ?? fenceStrippedText ?? envelopeUnwrappedText;
    const deterministicReasonCode =
      reasoningStrippedText !== null
        ? 'internal_reasoning_stripped'
        : fenceStrippedText !== null
          ? 'fence_stripped'
          : envelopeUnwrappedText !== null
            ? 'envelope_unwrapped'
            : null;

    // repair（hard cap 1）：rewrite 走独立 ReplyRepairAgent 受约束重写；replan 同参重进 generator。
    // 两条路都不带守卫反馈进 generator、不裁工具集。
    this.logger.log(
      `[invokeReviewed] output=${decision.decision}，触发一次受控修复: rules=${decision.ruleIds.join(',') || '-'}, ` +
        `violations=${decision.violations.map((v) => v.type).join(',') || '-'}` +
        (replan ? '，replan 档：同参数重进 generator 重生成一次' : '') +
        (fenceStrippedText !== null ? '，fence-only 命中走确定性剥围栏，跳过 LLM 重写' : '') +
        (reasoningStrippedText !== null ? '，推理独白命中走确定性剥离，跳过 LLM 重写' : '') +
        (envelopeUnwrappedText !== null ? '，JSON 信封命中走确定性拆封，跳过 LLM 重写' : ''),
    );
    const revised = replan
      ? await this.generator.invoke(params)
      : deterministicRepairText !== null
        ? this.buildRepairedResult(first, deterministicRepairText)
        : this.buildRepairedResult(
            first,
            await this.replyRepairAgent.repair({
              userMessage: ctx.userMessage,
              originalReply: firstText,
              violations: decision.violations,
              feedbackToGenerator: decision.feedbackToGenerator,
              ruleIds: decision.ruleIds,
              toolCalls: first.toolCalls ?? [],
              redLines: ctx.redLines,
              committedSideEffects: committed || undefined,
              repairContext: await this.buildReplyRepairContext(ctx),
            }),
          );

    const revisedText = OutboundReplySanitizer.stripTimeMarkers((revised.text ?? '').trim());
    // replan 是完整 Agent 回合，可能已通过工具转人工或主动跳过回复。
    // 这些终态不需要可投递正文，也不能把它们误作空修复再追加守卫介入。
    if (replan) {
      const resolution = resolveReviewedResolution(revised, { outcome: 'reply' });
      const toolEnded =
        resolution.outcome === 'handoff' ||
        (revised.toolCalls ?? []).some(isShortCircuitedToolCall);
      if (toolEnded) {
        this.persistReviewRecord(ctx, {
          result: revised,
          firstReply: firstText,
          firstDecision: decision,
          resolution,
          repaired: true,
          revisedReply: revisedText,
        });
        return this.finalizeReviewed(
          revised,
          decision,
          resolution,
          true,
          this.buildGuardrailTrace([firstStep], true, resolution),
        );
      }
    }
    // 悬空承接句 = repair 失败：repair 是本轮最后一次生成，"我帮你查下 X"式的将来时
    // 承诺不可能兑现，投递即空头承诺。与空文本同样由 Runner 决定回退或转人工，
    // 不送二审——二审只查规则违规，会放行。
    const danglingRepair = revisedText !== '' && isDanglingCheckReply(revisedText);
    if (!revisedText || danglingRepair) {
      if (danglingRepair) {
        this.logger.warn(
          `[invokeReviewed] repair 产物为悬空承接句，不能采用: text="${revisedText}"`,
        );
      }
      const resolution: OutputResolution = firstFailOpenEligible
        ? { outcome: 'reply', reasonCode: 'repair_unusable_fail_open' }
        : {
            outcome: 'handoff',
            source: 'output_guardrail',
            reasonCode: danglingRepair ? 'revise_dangling' : 'revise_empty',
          };
      // 空文本/悬空话术由 Runner 判定不可采用，未调用守卫二审，不能伪造审查步骤。
      this.persistReviewRecord(ctx, {
        result: firstFailOpenEligible ? first : revised,
        firstReply: firstText,
        firstDecision: decision,
        resolution,
        repaired: true,
        revisedReply: revisedText,
        committedSideEffects: committed || undefined,
      });
      return this.finalizeReviewed(
        firstFailOpenEligible ? first : revised,
        decision,
        resolution,
        !firstFailOpenEligible,
        this.buildGuardrailTrace([firstStep], true, resolution),
      );
    }

    // rewrite/剥围栏均不产生新工具调用，二审对账对象就是首版工具轨迹；
    // replan 有自己的工具轨迹（真实查岗后再答），二审与回归闸都以它为准。
    const reviewedToolCalls = replan ? (revised.toolCalls ?? []) : (first.toolCalls ?? []);
    const decision2 = await this.outputGuard.check(
      this.buildGuardInput(revised, ctx, reviewedToolCalls),
    );
    if (
      decision2.decision === 'repair' &&
      this.isOnlyInternalOutputLeak(decision2) &&
      firstFailOpenEligible
    ) {
      const resolution: OutputResolution = {
        outcome: 'reply',
        reasonCode: 'repair_unusable_fail_open',
      };
      this.persistReviewRecord(ctx, {
        result: first,
        firstReply: firstText,
        firstDecision: decision,
        resolution,
        repaired: true,
        revisedReply: revisedText,
        revisedDecision: decision2,
        committedSideEffects: committed || undefined,
      });
      return this.finalizeReviewed(
        first,
        decision,
        resolution,
        false,
        this.buildGuardrailTrace(
          [firstStep, this.toGuardrailStep('revised', decision2)],
          true,
          resolution,
        ),
      );
    }
    // §9：repair 死循环硬上限 1 —— 二次仍需修复 时按风险分级收敛：
    // - P0（riskLevel=high）或含不可恢复违规：handoff（不发送 + 人工介入），发出去即不可挽回；
    // - 仅 P1/P2 可恢复违规：fail-open 投递修复版 + 档案标注 repair_exhausted_fail_open。
    //   依据：假阳 × repair_exhausted 静默的组合杀伤最大（候选人在约面/收资节点整轮收不到
    //   回复），P1 级假阳的代价应是"多一条告警"而不是丢单。
    //   注意 repair 档规则本就定义为"可改写修复"的口径问题，修复版即使仍有残留，
    //   其风险也低于关键转化节点的整轮静默。
    const wantsRepairAgain = decision2.decision !== 'pass' && decision2.decision !== 'observe';
    // replan 档不 fail-open：重生成后仍不通过，或二审新要求查证，都不能作为低风险残留放行。
    const failOpenEligible =
      wantsRepairAgain &&
      !replan &&
      decision2.repairMode !== GUARDRAIL_REPAIR_MODE.REPLAN &&
      decision2.riskLevel !== 'high' &&
      decision2.violations.every((v) => v.allowFailOpen !== false);
    if (failOpenEligible) {
      this.logger.warn(
        `[invokeReviewed] repair 上限用尽但仅剩 P1/P2 可恢复违规，fail-open 投递修复版: ` +
          `rules=${decision2.ruleIds.join(',') || '-'}, traceId=${ctx.traceId ?? '-'}`,
      );
    }
    // 确定性 repair 回归闸门（P1-5）：二审只判"修复版是否违规"，不比较
    // "相对首版是否退步"——结构压扁/结论反转的修复版曾带着二审 pass 直接投递
    // 。检测需同时读取真实岗位证据，避免把删除幻觉岗位误判
    // 为退化。fence_stripped / envelope_unwrapped 是逐字剥离/提取，不可能回归，跳过检测
    // ——拆封产物相对信封原文本就是"结构骤变"，跑回归闸只会误报。
    const regression =
      deterministicRepairText === null
        ? detectRepairRegression(firstText, revisedText, {
            committedSideEffects: committed || undefined,
            jobEvidenceAvailable: this.resolveJobEvidenceAvailability(reviewedToolCalls),
            firstBlockedRuleIds: decision.blockedRuleIds,
            firstRepairMode: decision.repairMode,
          })
        : null;
    // 检出回归后的收敛对齐 guardrail-quality-system.md §2.3 ④：
    // 首版可 fail-open（P1/P2 全部可恢复且非高风险）→ 回退首版；
    // 首版不可 fail-open（P0/泄漏类/高风险）→ 两版都不投，转人工并留档——
    // 修复版已证明退化，首版又是守卫明确否决的泄漏/红线内容，谁都不能进投递链。
    // 注意不能用 violation.currentReplySendable 判定：repair 档一律派生为 false，会把
    // "P1/P2 回退首版"整条路径变成不可达。
    const regressionBlock = regression !== null && !firstFailOpenEligible;
    const regressionRevert = regression !== null && !regressionBlock;
    if (regressionBlock) {
      this.logger.warn(
        `[invokeReviewed] repair 回归（${regression}）且首版不可 fail-open，两版都不投递: ` +
          `rules=${decision.ruleIds.join(',') || '-'}, traceId=${ctx.traceId ?? '-'}`,
      );
    }
    if (regressionRevert) {
      this.logger.warn(
        `[invokeReviewed] repair 回归（${regression}），弃用修复版回退首版: ` +
          `rules=${decision.ruleIds.join(',') || '-'}, traceId=${ctx.traceId ?? '-'}`,
      );
    }
    const resolution: OutputResolution = regressionBlock
      ? {
          outcome: 'handoff',
          source: 'output_guardrail',
          reasonCode: `repair_regression_blocked:${regression}`,
        }
      : wantsRepairAgain
        ? failOpenEligible
          ? { outcome: 'reply', reasonCode: 'repair_exhausted_fail_open' }
          : {
              outcome: 'handoff',
              source: 'output_guardrail',
              reasonCode: replan ? 'replan_exhausted' : 'repair_exhausted',
            }
        : {
            outcome: 'reply',
            reasonCode: regressionRevert
              ? `repair_regression_reverted:${regression}`
              : (decision2.reasonCode ??
                deterministicReasonCode ??
                (replan ? 'replanned' : undefined)),
          };
    const finalResult = regressionBlock
      ? { ...revised, toolCalls: reviewedToolCalls }
      : wantsRepairAgain
        ? failOpenEligible &&
          firstFailOpenEligible &&
          (this.isSecondDecisionWorse(decision, decision2) || regressionRevert)
          ? first
          : { ...revised, toolCalls: reviewedToolCalls }
        : regressionRevert
          ? first
          : { ...revised, toolCalls: reviewedToolCalls };
    const finalRevised = finalResult !== first;
    this.persistReviewRecord(ctx, {
      result: finalResult,
      firstReply: firstText,
      firstDecision: decision,
      resolution,
      repaired: true,
      revisedReply: revisedText,
      revisedDecision: decision2,
      committedSideEffects: committed || undefined,
    });
    return this.finalizeReviewed(
      finalResult,
      finalResult === first ? decision : decision2,
      resolution,
      finalRevised,
      this.buildGuardrailTrace(
        [firstStep, this.toGuardrailStep('revised', decision2)],
        true,
        resolution,
      ),
    );
  }

  /**
   * 落一条出站守卫审查档案（guardrail_review_records，稀疏附属表）：
   * 首版全文 + 违规证据全文 + 重写版全文——紧凑摘要（guardrail_output 列）刻意不带、
   * 但详情页复盘必需的部分。
   *
   * - 仅在带 traceId 时写。注意 debug-chat（`sessionId:时间戳`）与 test-suite（synthetic id）
   *   也会构造 traceId，档案并非纯生产数据，按 traceId 形态区分；
   * - 仅守卫有信号时写（非 pass、有 rule 观测命中或有 runtime override 命中），放行回合不产生行；
   * - fire-and-forget：三态写入结果只用于观测告警，绝不阻塞/拖垮回复链路。
   */
  private persistReviewRecord(
    ctx: ReviewContext,
    data: {
      result: GeneratorRunResult;
      firstReply: string;
      firstDecision: OutputGuardDecision;
      resolution: OutputResolution;
      repaired: boolean;
      revisedReply?: string;
      revisedDecision?: OutputGuardDecision;
      committedSideEffects?: string;
    },
  ): void {
    const resolution = resolveReviewedResolution(data.result, data.resolution);
    const overrideMarkers = Array.from(
      new Set([
        ...(data.firstDecision.overrideMarkers ?? []),
        ...(data.revisedDecision?.overrideMarkers ?? []),
      ]),
    );
    const hasSignal =
      data.firstDecision.decision !== 'pass' ||
      data.firstDecision.ruleIds.length > 0 ||
      overrideMarkers.length > 0;
    if (!hasSignal) return;
    // 观测 P1-2：repair 终局事件落在归档口而非各分支——六个调用点一处不漏，
    // 包含空修复与悬空话术；未发生二审时保留修复事实，不伪造审查步骤。
    // 放在 traceId 早退之前：事件的 traceId 由 tracer 从请求上下文补齐，不依赖档案能否落库。
    if (data.repaired) {
      this.tracer?.emit({
        type: 'guardrail_repair',
        outcome:
          resolution.reasonCode ??
          (resolution.outcome === 'reply' ? 'repaired' : resolution.outcome),
        finalOutcome: resolution.outcome,
        riskLevel: (data.revisedDecision ?? data.firstDecision).riskLevel,
        firstRuleIds: [...data.firstDecision.ruleIds],
        finalRuleIds: [...(data.revisedDecision ?? data.firstDecision).ruleIds],
        repairMode: data.firstDecision.repairMode,
      });
    }
    if (!ctx.traceId) return;
    let reasonCode = resolution.reasonCode;
    if (!reasonCode && resolution.outcome === 'handoff') {
      reasonCode = 'unattributed_handoff';
      this.logger.warn(`[invokeReviewed] 人工介入缺少 reasonCode: traceId=${ctx.traceId}`);
    }
    if (overrideMarkers.length > 0) {
      reasonCode = [reasonCode, ...overrideMarkers].filter(Boolean).join('|');
    }
    const baseRecord = {
      traceId: ctx.traceId,
      chatId: ctx.chatId,
      userId: ctx.userId,
      botImId: ctx.botImId,
      botUserName: ctx.botUserName,
      contactName: ctx.contactName,
      userMessage: ctx.userMessage,
      firstReply: data.firstReply,
      first: this.toReviewStepDetail(data.firstDecision),
      finalOutcome: resolution.outcome,
      reasonCode,
    };
    const reviewRecord: GuardrailReviewInsertInput = data.repaired
      ? {
          ...baseRecord,
          repairMode: data.firstDecision.repairMode,
          repaired: true,
          revisedReply: data.revisedReply ?? '',
          revised: data.revisedDecision ? this.toReviewStepDetail(data.revisedDecision) : undefined,
          committedSideEffects: data.committedSideEffects,
        }
      : {
          ...baseRecord,
          repaired: false,
          committedSideEffects: data.committedSideEffects,
        };

    void this.guardrailReviews
      .recordReview(reviewRecord)
      .then((outcome) => {
        if (outcome === 'failed') {
          this.logger.warn(`[invokeReviewed] 审查档案落库失败: traceId=${ctx.traceId}`);
        }
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `[invokeReviewed] 审查档案落库失败: traceId=${ctx.traceId}, ` +
            `err=${toErrorMessage(error)}`,
        );
      });
  }

  private toReviewStepDetail(decision: OutputGuardDecision): GuardrailReviewStepDetail {
    return {
      decision: decision.decision,
      riskLevel: decision.riskLevel,
      ruleIds: decision.ruleIds,
      blockedRuleIds: decision.blockedRuleIds,
      violations: decision.violations,
      feedback: decision.feedbackToGenerator,
    };
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
    resolution: OutputResolution,
  ): GuardrailTurnTrace {
    return {
      steps,
      repaired,
      finalOutcome: resolution.outcome,
      reasonCode: resolution.reasonCode,
    };
  }

  private isFirstReplyFailOpenEligible(decision: OutputGuardDecision): boolean {
    return (
      decision.riskLevel !== 'high' &&
      decision.violations.every((violation) => violation.allowFailOpen !== false)
    );
  }

  /**
   * 返回本轮查岗证据两态：
   * - true：至少一次 duliday_job_list 有正向成功信号/非空结果；
   * - false：本轮没有可用岗位证据（查了全空，或根本没查）。
   *
   * 中间一次成功、随后复核为空时仍返回 true，和 review packet “优先取最后一次可用
   * 结果”的证据语义保持一致。
   */
  private resolveJobEvidenceAvailability(toolCalls: AgentToolCall[]): boolean {
    const jobListCalls = toolCalls.filter((call) => call.toolName === 'duliday_job_list');
    // 零查岗轮视同无岗位证据：本轮一次查岗都没调时，首版的岗位事实必然无工具支撑——
    // repair 诚实删除编造岗位的改写不能被判 structure_collapsed 回退成编造原文投递。
    if (jobListCalls.length === 0) return false;
    return jobListCalls.some(
      (call) =>
        (typeof call.resultCount === 'number' && call.resultCount > 0) ||
        call.status === 'ok' ||
        call.status === 'narrow' ||
        isToolSuccess(call.result),
    );
  }

  private isOnlyInternalOutputLeak(decision: OutputGuardDecision): boolean {
    return (
      decision.blockedRuleIds.length > 0 &&
      decision.blockedRuleIds.every((ruleId) => ruleId === 'internal_output_leak')
    );
  }

  /**
   * fence-only 泄漏的确定性最小修复：不可发送命中仅为 internal_output_leak，且剥掉
   * markdown 围栏标记后词库再无任何命中 → 返回剥离后的文本（围栏内正文逐字保留）。
   * 其余情况（混合命中、剥完仍有泄漏、剥完为空）返回 null，交给常规 LLM repair。
   *
   * 领域合规前置：快通道的隐含前提是"围栏是这条回复唯一的问题"，整篇跨域技术内容会
   * 击穿它（剥完围栏词库不再命中，逐字放行给候选人）。剥离产物呈技术文档形态时不走
   * 快通道，交给常规 repair（该路径还会过回归闸）。
   */
  private tryStripFenceOnlyLeak(decision: OutputGuardDecision, text: string): string | null {
    if (!this.isOnlyInternalOutputLeak(decision)) return null;
    const stripped = stripMarkdownCodeFences(text);
    if (!stripped || stripped === text) return null;
    if (detectOutputLeak(stripped)) return null;
    if (hasTechnicalDocumentationShape(stripped)) {
      this.logger.warn(
        `[invokeReviewed] fence-only 命中但剥离产物呈技术文档形态，放弃确定性快通道: ` +
          `text="${stripped.slice(0, 80)}"`,
      );
      return null;
    }
    return stripped;
  }

  /** 推理独白混入正常正文时只机械删掉实证形态；剥完为空的情况由直达静默分支处理。 */
  private tryStripInternalReasoningLeak(
    decision: OutputGuardDecision,
    text: string,
  ): string | null {
    if (!this.isOnlyInternalOutputLeak(decision)) return null;
    const stripped = stripInternalReasoningArtifacts(text);
    if (!stripped || stripped === text) return null;
    if (detectOutputLeak(stripped)) return null;
    return stripped;
  }

  /**
   * JSON 信封的确定性最小修复：不可发送命中仅为 internal_output_leak，且整条首版是
   * "正文被包进 JSON 信封"的形态（`{"agent_response":"好的，我帮你看下…"}`）→ 拆出信封内
   * 正文逐字放行。不拆则该形态会被残文判据误伤成整轮静默。
   *
   * 拆封判定（含 tool_use 结构键黑名单、唯一候选、正文自身无泄漏/非技术文档）
   * 收敛在 tryUnwrapEnvelopeReply；拆封产物仍走二审 + 悬空承接句检测，二审才是放行依据。
   */
  private tryUnwrapEnvelopeLeak(decision: OutputGuardDecision, text: string): string | null {
    if (!this.isOnlyInternalOutputLeak(decision)) return null;
    const unwrapped = tryUnwrapEnvelopeReply(text);
    if (unwrapped === null) return null;
    this.logger.warn(
      `[invokeReviewed] 首版为 JSON 信封形态，确定性拆封放出正文: text="${unwrapped.slice(0, 80)}"`,
    );
    return unwrapped;
  }

  /**
   * 直达静默判据——三类首版进 repair 只会产出另一条不该发的文本：
   *
   * - `meta_narration_silenced`：元叙述旁白表达的真实意图就是不回复。
   * - `tool_call_artifact_silenced`：整条首版只是工具调用残文；剥离后无正文可供 rewrite
   *   保留，没有事实可依时只能静默。
   * 混合命中其它规则时都不走捷径，仍按常规 repair 流程保守处理。
   */
  private resolveDirectSilenceReason(
    decision: OutputGuardDecision,
    firstText: string,
  ): string | null {
    if (decision.decision === 'repair') {
      if (this.isOnlyMetaNarration(decision)) return 'meta_narration_silenced';
      if (this.isOnlyInternalOutputLeak(decision) && isInternalReasoningArtifactOnly(firstText)) {
        return 'internal_reasoning_artifact_silenced';
      }
      if (this.isOnlyInternalOutputLeak(decision) && isToolCallArtifactOnly(firstText)) {
        return 'tool_call_artifact_silenced';
      }
      return null;
    }
    return null;
  }

  private isOnlyMetaNarration(decision: OutputGuardDecision): boolean {
    return (
      decision.blockedRuleIds.length > 0 &&
      decision.blockedRuleIds.every((ruleId) => ruleId === 'meta_narration_reply')
    );
  }

  /**
   * fail-open 时修复版默认胜出（P1-3）。
   *
   * 旧判据是"首版 blocked 规则集完全复燃 → 弃修复版投首版"，把本窗口 10/16 的
   * fail-open 修复版丢回首版，其中多例修复版明确更优（结算口径精确化、删掉洗身份
   * 叙述）却被弃用，甚至致洗身份文本实际投递。同一规则
   * 复燃时两版违规程度相同，而修复版还多消化了一次反馈与二审；因此只有修复版引入
   * 首版没有的新 blocked 规则（真变差）才回退首版。结构压扁/结论反转类退化由
   * 确定性回归闸门（detectRepairRegression）在调用点并联把守。
   */
  private isSecondDecisionWorse(
    firstDecision: OutputGuardDecision,
    secondDecision: OutputGuardDecision,
  ): boolean {
    const firstBlocked = new Set(firstDecision.blockedRuleIds);
    return secondDecision.blockedRuleIds.some((ruleId) => !firstBlocked.has(ruleId));
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
    sessionRef: SessionRef;
    messageId?: string;
    onTurnEndError?: (error: unknown) => void;
  }): Promise<ReviewedTurnRunResult> {
    const result = await this.invokeReviewed(params.invoke, params.review);
    const outcome = classifyReviewedOutcome(result, params.sessionRef, params.messageId);
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
      // 与 invokeReviewed 的 firstText/revisedText 同口径：审查剥时间标记后的文本。
      reply: OutboundReplySanitizer.stripTimeMarkers((result.text ?? '').trim()),
      toolCalls,
      memorySnapshot: result.memorySnapshot,
      turnLedger: result.turnLedger,
      redLines: ctx.redLines ?? [],
      userMessage: ctx.userMessage,
      chatId: ctx.chatId,
      userId: ctx.userId,
      corpId: ctx.sessionRef?.corpId,
      traceId: ctx.traceId,
      contactName: ctx.contactName,
      botImId: ctx.botImId,
      botUserName: ctx.botUserName,
    };
  }

  private async buildReplyRepairContext(
    ctx: ReviewContext,
  ): Promise<ReplyRepairContext | undefined> {
    if (!this.replyRepairContextProvider || !ctx.sessionRef) return undefined;
    try {
      return await this.replyRepairContextProvider.build({
        corpId: ctx.sessionRef.corpId,
        userId: ctx.sessionRef.userId,
        sessionId: ctx.sessionRef.sessionId,
        botUserId: ctx.botUserName,
        currentUserMessage: ctx.userMessage,
        shortTermEndTimeInclusive: ctx.shortTermEndTimeInclusive,
      });
    } catch (error) {
      this.logger.warn(
        `[invokeReviewed] reply repair 上下文读取失败: sessionId=${ctx.sessionRef.sessionId}, ` +
          `err=${toErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  private buildRepairedResult(result: GeneratorRunResult, text: string): GeneratorRunResult {
    const previousRunTurnEnd = result.runTurnEnd;
    return {
      ...result,
      text,
      responseMessages: this.repairAssistantResponseMessages(result.responseMessages, text),
      runTurnEnd: previousRunTurnEnd
        ? (options) => previousRunTurnEnd({ ...options, assistantTextOverride: text })
        : undefined,
    };
  }

  private repairAssistantResponseMessages(
    responseMessages: Array<Record<string, unknown>> | undefined,
    text: string,
  ): Array<Record<string, unknown>> | undefined {
    if (!responseMessages) return undefined;
    let replaced = false;
    return responseMessages.map((message) => {
      if (message.role !== 'assistant') return message;
      const parts = Array.isArray(message.parts) ? message.parts : undefined;
      if (!parts) return message;
      return {
        ...message,
        parts: parts.map((part) => {
          if (replaced || !part || typeof part !== 'object' || Array.isArray(part)) return part;
          const record = part as Record<string, unknown>;
          if (record.type !== 'text') return part;
          replaced = true;
          return { ...record, text };
        }),
      };
    });
  }

  /** 把本轮已成功的副作用工具压成一句既成事实提示（喂给 repair 重写，防"声称未发生/重复执行"）。 */
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
    resolution: OutputResolution,
    revised: boolean,
    guardrailTrace?: GuardrailTurnTrace,
  ): ReviewedRunResult {
    // runTurnEnd 一律透传：触发时机（含 handoff/skipped 时的 includeAssistantText=false）由
    // TurnFinalizer 在投递结局已知后统一决定，runner 不再代为触发。
    const finalResolution = resolveReviewedResolution(result, resolution);
    return {
      ...result,
      runTurnEnd: this.bindTurnEndContext(result.runTurnEnd),
      outputDecision: decision,

      resolution: finalResolution,
      revised,
      guardrailTrace: guardrailTrace
        ? {
            ...guardrailTrace,
            finalOutcome: finalResolution.outcome,
            reasonCode: finalResolution.reasonCode,
          }
        : undefined,
    };
  }

  /**
   * 记忆收尾闭包由渠道在投递结局已知后才触发，那时 AsyncLocalStorage 里已经没有本回合的
   * 请求上下文：收尾期间发射的事件（extract 的 llm_execution、brand_state_change、
   * session_state_field_dropped）会整批丢掉 trace 维度。创建闭包时捕获上下文，触发时再进入。
   */
  private bindTurnEndContext(
    runTurnEnd: GeneratorRunResult['runTurnEnd'],
  ): GeneratorRunResult['runTurnEnd'] {
    const requestContext = this.requestContext;
    const context = requestContext?.get();
    if (!runTurnEnd || !requestContext || !context || Object.keys(context).length === 0) {
      return runTurnEnd;
    }
    return (options) => requestContext.run(context, () => runTurnEnd(options));
  }

  stream(
    params: GeneratorInvokeParams & {
      onFinish?: (result: GeneratorRunResult) => Promise<void> | void;
    },
  ): Promise<GeneratorStreamResult> {
    return this.generator.stream(params);
  }

  /** 编排一个被动入站回合（渠道无关、不投递）；异常抛回渠道，由渠道 fallback 接管。 */
  async runInboundTurn(req: InboundTurnRequest): Promise<TurnOutcome> {
    const { sessionRef, context } = req;
    const telemetryContext = {
      traceId: context?.messageId,
      chatId: sessionRef.sessionId,
      userId: sessionRef.userId,
      corpId: sessionRef.corpId,
      scenario: context?.scenario,
      callerKind: context?.callerKind ?? CallerKind.WECOM,
    };

    const run = () => this.runInboundTurnObserved(req);
    if (this.requestContext) {
      return this.requestContext.run(telemetryContext, run);
    }
    return run();
  }

  private async runInboundTurnObserved(req: InboundTurnRequest): Promise<TurnOutcome> {
    const startedAt = Date.now();
    this.tracer?.emit({ type: 'agent_start' });

    try {
      const outcome = await this.runInboundTurnInternal(req);
      this.tracer?.emit({
        type: 'agent_end',
        steps: outcome.agentSteps?.length,
        totalTokens: outcome.usage?.totalTokens,
        cachedTokens: outcome.usage?.cachedInputTokens,
        durationMs: Date.now() - startedAt,
      });
      return outcome;
    } catch (error) {
      this.tracer?.emit({
        type: 'agent_error',
        error: toErrorMessage(error),
      });
      throw error;
    }
  }

  private async runInboundTurnInternal(req: InboundTurnRequest): Promise<TurnOutcome> {
    const { sessionRef, input, context } = req;

    const inboundOutcome = await this.precheckInboundOutcome({
      corpId: sessionRef.corpId,
      chatId: sessionRef.sessionId,
      userId: sessionRef.userId,
      pauseTargetId: sessionRef.sessionId || sessionRef.userId,
      scanContent: this.buildInputGuardScanContent(input.text),
      messageId: context?.messageId,
      contactName: context?.contactName,
      botImId: context?.botImId,
      botUserName: context?.botUserId,
    });
    if (inboundOutcome) return inboundOutcome;

    const params: GeneratorInvokeParams = {
      callerKind: context?.callerKind ?? CallerKind.WECOM,
      userId: sessionRef.userId,
      corpId: sessionRef.corpId,
      sessionId: sessionRef.sessionId,
      messageId: context?.messageId,
      messages: [
        {
          role: 'user',
          content: input.text,
          imageUrls: input.images,
          imageMessageIds: context?.imageMessageIds,
        },
      ],
      toolMode: req.toolMode ?? 'scenario',
      scenario: context?.scenario,
      imageUrls: input.images,
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
      hasNewerUserInput: context?.hasNewerUserInput,
      onPreparedRequest: context?.onPreparedRequest,
    };

    const result = await this.invokeReviewed(params, {
      sessionRef,
      userMessage: input.text,
      chatId: sessionRef.sessionId,
      userId: sessionRef.userId,
      traceId: context?.messageId,
      contactName: context?.contactName,
      botImId: context?.botImId,
      botUserName: context?.botUserId,
      shortTermEndTimeInclusive: context?.shortTermEndTimeInclusive,
    });

    // 终态分类与渠道共享同一处纯函数（classifyReviewedOutcome）：无法安全放行→handoff/outbound、
    // committed handoff / booking gate→handoff、短路/空文本→skipped、其余→reply。
    const outcome = classifyReviewedOutcome(result, sessionRef, context?.messageId);
    if (outcome.kind === 'handoff' && outcome.guardrail?.phase === 'outbound') {
      this.logger.warn(
        `[runInboundTurn] 出站守卫拦截: sessionId=${sessionRef.sessionId}, ` +
          `rules=${result.outputDecision.blockedRuleIds.join(',') || '-'}, ` +
          `reason=${result.resolution.reasonCode ?? '-'}`,
      );
    }
    return outcome;
  }

  private buildInputGuardScanContent(userMessage: string): string {
    const content = userMessage.trim();
    if (!content) return '';

    const textLines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !VISUAL_GENERATED_CONTENT_PATTERN.test(line));

    return textLines.join('\n');
  }
}

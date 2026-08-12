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
import type {
  GuardrailReviewStepTrace,
  GuardrailTurnTrace,
} from '@shared-types/guardrail.contract';
import { GuardrailReviewService } from '@biz/message/services/guardrail-review.service';
import type {
  GuardrailReviewInsertInput,
  GuardrailReviewStepDetail,
} from '@biz/message/types/guardrail-review.types';
import { classifyReviewedOutcome } from './turn-outcome';
import { isDanglingCheckReply } from './dangling-reply';
import {
  detectOutputLeak,
  hasTechnicalDocumentationShape,
  isToolCallArtifactOnly,
  stripMarkdownCodeFences,
  tryUnwrapEnvelopeReply,
} from '../guardrail/output/rules/internal-info-leaks.rule';
import { OutboundReplySanitizer } from '../guardrail/output/outbound-reply-sanitizer';
import { detectRepairRegression } from '../guardrail/output/repair-regression.util';
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

const VISUAL_GENERATED_CONTENT_PATTERN = /^\s*\[(?:图片|表情)消息\]/;

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
 * - `runTurn`：渠道无关回合编排入口。被动 inbound 与主动 reengagement 汇入同一处，
 *   产出 `TurnOutcome`，runner 不负责投递。
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
   * `{ hit: true }` + 风险归因。当前无生产调用方——渠道走 runTurn，内部经
   * precheckInboundOutcome 完成入站预检。守卫本身**只判定不执行副作用**——人工介入
   * （暂停托管 + 飞书告警）以 sideEffect intent 挂在 outcome 上，由渠道在 replay 定局后
   * 经 TurnOutcomeInterventionService.commit 统一出口执行，避免被 replay 丢弃的首版
   * 误触发暂停/告警。
   *
   * 注意这只是 input 守卫的「pre-agent 拦截」一环；prompt-injection 硬化（扫注入→告警→
   * 追加 system 防护 suffix）由 PromptInjectionService 在 preparation 阶段执行，不经此入口。
   *
   * 渠道侧只负责把入站 DTO 解析成中立 `RiskInterceptInput`（依赖倒置，DTO/parser 留渠道），
   * pre-agent 拦截的「何时调、调哪个守卫」编排权收敛在 runner，与出站守卫（invokeReviewed）
   * 对称。
   */
  precheckInput(input: RiskInterceptInput): Promise<PreAgentRiskPrecheckResult> {
    return this.inputGuard.precheckInputRisk(input);
  }

  /**
   * 入站风险预检 → 收口成 `TurnOutcome`（input guardrail 的**短路决策**归位到 runner，与出站
   * 守卫统一产出 `guardrail_blocked`）。
   *
   * - 命中：这里收成 `guardrail_blocked/inbound` 终态并携带 sideEffects（本轮不跑 Agent），
   *   由渠道在 replay 定局后经 TurnOutcomeInterventionService.commit 统一执行副作用。
   *   渠道只负责静默收尾（commit 副作用/记跳过观测/去重/ack）。
   * - 未命中：返回 `null`，调用方继续走正常生成。
   */
  async precheckInboundOutcome(input: RiskInterceptInput): Promise<TurnOutcome | null> {
    const decision = await this.inputGuard.evaluate(input);
    if (decision.decision === 'pass') return null;

    return {
      kind: 'guardrail_blocked',
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
   * - decision='revise'：丢弃首版，交给独立 ReplyRepairAgent 按 violations + 已知事实做文本修复；
   *   再审一次；二次仍不过按 §9「repair 死循环硬上限 1」分级收敛。
   * - decision='block'：先进入一次受控修复；二审仍不通过才不投递。
   *
   * （2026-07-27 发牌切换收尾：replan 修复模式已整体退役——GuardrailRuleAction 已删
   *   REPLAN、语义档裁决在 normalizeDecision 归一为 revise，本方法不再存在重进
   *   generator 的修复路径；历史语义见评估文档 §2.4。）
   *
   * turn-end 语义：内部生成强制 `deferTurnEnd`（repair 产物复用首版的 runTurnEnd），确保被丢弃的首版不写记忆；最终采纳版的
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

    // 审查前先剥模型模仿输出的 `[消息发送时间：…]` 标记（占全部回合 ~11%，2026-07-24 审计）：
    // 避免噪声进入 LLM 审查上下文与守卫档案。只剥时间标记，不跑完整 sanitize——后者会剥
    // 反引号，破坏 internal_output_leak 的围栏检测。投递文本另由 turn-outcome 统一清洗。
    const firstText = OutboundReplySanitizer.stripTimeMarkers((first.text ?? '').trim());
    const firstSkipped = (first.toolCalls ?? []).some(isShortCircuitedToolCall);
    if (!firstText || firstSkipped) {
      return this.finalizeReviewed(first, PASS_DECISION, false, wantDefer);
    }

    const decision = await this.outputGuard.check(this.buildGuardInput(first, ctx));
    const firstStep = this.toGuardrailStep('first', decision);

    // 直达静默：这两类首版重写只会产出"另一条不该发的文本"，与悬空承接句同理
    // 收敛为 block（沉默 + 落审查档案），不进 repair、不送二审。
    const silenceReason = this.resolveDirectSilenceReason(decision, firstText);
    if (silenceReason) {
      const silencedDecision: OutputGuardDecision = {
        ...decision,
        // handoff_promise_only_reply_silenced 的首审是 revise 档，静默收敛必须显式压成
        // block——沿用 revise 会让 finalize 把首版当可投递文本发出去。
        decision: 'block',
        reasonCode: silenceReason,
      };
      this.logger.warn(
        `[invokeReviewed] 首版命中直达静默（${silenceReason}），收敛为 block（整轮静默）: ` +
          `text="${firstText.slice(0, 80)}"`,
      );
      this.persistReviewRecord(ctx, {
        firstReply: firstText,
        firstDecision: decision,
        finalDecision: silencedDecision,
        repaired: false,
      });
      return this.finalizeReviewed(
        first,
        silencedDecision,
        false,
        wantDefer,
        this.buildGuardrailTrace([firstStep], false, silencedDecision),
      );
    }

    const shouldRepair = decision.decision !== 'pass' && decision.decision !== 'observe';
    if (!shouldRepair) {
      this.persistReviewRecord(ctx, {
        firstReply: firstText,
        firstDecision: decision,
        finalDecision: decision,
        repaired: false,
      });
      return this.finalizeReviewed(
        first,
        decision,
        false,
        wantDefer,
        this.buildGuardrailTrace([firstStep], false, decision),
      );
    }

    // 确定性修复快通道：仅命中 internal_output_leak 且剥掉代码围栏标记后不再有任何
    // 泄漏形态时，剥离本身就是完整修复——围栏内正文（报名表模板等结构化内容）逐字保留，
    // 跳过 LLM 重写（2026-07-21 badcase：rewrite 把围栏里的报名表模板压成一句话流水账）。
    // 剥离产物仍走下方二审，二审才是放行依据。
    const fenceStrippedText = this.tryStripFenceOnlyLeak(decision, firstText);
    // 第二条确定性快通道（2026-08-04 审计 P0-2）：JSON 信封拆封。模型把完整正文包进
    // `{"agent_response":"…"}` 类信封，旧链路误判纯残文整轮静默（好回复被吞）。拆封
    // 产物与剥围栏同样走二审 + 悬空检测。
    const envelopeUnwrappedText =
      fenceStrippedText === null ? this.tryUnwrapEnvelopeLeak(decision, firstText) : null;
    const deterministicRepairText = fenceStrippedText ?? envelopeUnwrappedText;
    const deterministicReasonCode =
      fenceStrippedText !== null
        ? 'fence_stripped'
        : envelopeUnwrappedText !== null
          ? 'envelope_unwrapped'
          : null;

    // repair（hard cap 1）：统一走独立 ReplyRepairAgent 受约束重写——replan（重进
    // generator 重取数+重写全文）已于 2026-07-27 发牌切换整体退役（评估文档 §2.4），
    // 全链路只剩一个能改候选人可见文本的写手。
    const committed = this.summarizeCommittedSideEffects(first.toolCalls ?? []);
    this.logger.log(
      `[invokeReviewed] output=${decision.decision}，触发一次受控修复: rules=${decision.ruleIds.join(',') || '-'}, ` +
        `violations=${decision.violations.map((v) => v.type).join(',') || '-'}` +
        (fenceStrippedText !== null ? '，fence-only 命中走确定性剥围栏，跳过 LLM 重写' : '') +
        (envelopeUnwrappedText !== null ? '，JSON 信封命中走确定性拆封，跳过 LLM 重写' : ''),
    );
    const revised =
      deterministicRepairText !== null
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
    // 悬空承接句 = repair 失败：repair 是本轮最后一次生成，"我帮你查下 X"式的
    // 将来时承诺不可能兑现，投递即空头承诺（badcase batch_6a4790c7…：候选人
    // 只收到一句"我帮你查下花桥中骏附近的岗位"，之后再无下文）。与空文本同样
    // 收敛为 block（沉默 + 落审查档案），不送二审——二审只查规则违规，会放行。
    const danglingRepair = revisedText !== '' && isDanglingCheckReply(revisedText);
    if (!revisedText || danglingRepair) {
      if (danglingRepair) {
        this.logger.warn(
          `[invokeReviewed] repair 产物为悬空承接句，收敛为 block: text="${revisedText}"`,
        );
      }
      const emptyDecision: OutputGuardDecision = {
        ...decision,
        decision: 'block',
        reasonCode: danglingRepair ? 'revise_dangling' : 'revise_empty',
      };
      // 悬空文本刻意不送二审，没有针对修复文本的真实裁决——revised 步骤必须用
      // 干净的 decision 归档，不能 spread 首审对象：否则首版回复的 ruleIds/
      // violations 会被错误归到重写文本名下，污染守卫档案的取证价值。
      const danglingStepDecision: OutputGuardDecision = {
        decision: 'block',
        riskLevel: 'low',
        violations: [],
        ruleIds: [],
        blockedRuleIds: [],
        repairMode: decision.repairMode,
        reasonCode: danglingRepair ? 'revise_dangling' : 'revise_empty',
      };
      if (this.isFirstReplyFailOpenEligible(decision)) {
        const failOpenDecision: OutputGuardDecision = {
          ...decision,
          decision: 'pass',
          reasonCode: 'repair_unusable_fail_open',
        };
        this.persistReviewRecord(ctx, {
          firstReply: firstText,
          firstDecision: decision,
          finalDecision: failOpenDecision,
          repaired: true,
          revisedReply: revisedText,
          revisedDecision: danglingStepDecision,
          committedSideEffects: committed || undefined,
        });
        return this.finalizeReviewed(
          first,
          failOpenDecision,
          false,
          wantDefer,
          this.buildGuardrailTrace(
            [firstStep, this.toGuardrailStep('revised', danglingStepDecision)],
            true,
            failOpenDecision,
          ),
        );
      }
      this.persistReviewRecord(ctx, {
        firstReply: firstText,
        firstDecision: decision,
        finalDecision: emptyDecision,
        repaired: true,
        revisedReply: revisedText,
        // 悬空场景有真实修复文本，补 revisedDecision 让档案落库（空文本场景
        // 维持原跳过行为：无修复内容可归档）。
        revisedDecision: danglingRepair ? danglingStepDecision : undefined,
        committedSideEffects: committed || undefined,
      });
      return this.finalizeReviewed(
        revised,
        emptyDecision,
        true,
        wantDefer,
        this.buildGuardrailTrace(
          danglingRepair
            ? [firstStep, this.toGuardrailStep('revised', danglingStepDecision)]
            : [firstStep],
          true,
          emptyDecision,
        ),
      );
    }

    // rewrite/剥围栏均不产生新工具调用，二审对账对象就是首版工具轨迹。
    const reviewedToolCalls = first.toolCalls ?? [];
    const decision2 = await this.outputGuard.check(
      this.buildGuardInput(revised, ctx, reviewedToolCalls),
    );
    if (
      decision2.decision === 'block' &&
      this.isOnlyInternalOutputLeakBlock(decision2) &&
      this.isFirstReplyFailOpenEligible(decision)
    ) {
      const failOpenDecision: OutputGuardDecision = {
        ...decision,
        decision: 'pass',
        reasonCode: 'repair_unusable_fail_open',
      };
      this.persistReviewRecord(ctx, {
        firstReply: firstText,
        firstDecision: decision,
        finalDecision: failOpenDecision,
        repaired: true,
        revisedReply: revisedText,
        revisedDecision: decision2,
        committedSideEffects: committed || undefined,
      });
      return this.finalizeReviewed(
        first,
        failOpenDecision,
        false,
        wantDefer,
        this.buildGuardrailTrace(
          [firstStep, this.toGuardrailStep('revised', decision2)],
          true,
          failOpenDecision,
        ),
      );
    }
    // §9：repair 死循环硬上限 1 —— 二次仍 revise 时按风险分级收敛：
    // - P0（riskLevel=high）或含不可恢复违规：block（静默 + 档案），发出去即不可挽回；
    // - 仅 P1/P2 可恢复违规：fail-open 投递修复版 + 档案标注 repair_exhausted_fail_open。
    //   依据 2026-07-06 生产守卫档案首日复盘：假阳 × repair_exhausted 静默的组合杀伤最大
    //   （候选人在约面/收资节点整轮收不到回复），P1 级假阳的代价应是"多一条告警"而不是丢单。
    //   注意 revise 档规则本就定义为"可改写修复"的口径问题，修复版即使仍有残留，
    //   其风险也低于关键转化节点的整轮静默。
    const wantsRepairAgain = decision2.decision !== 'pass' && decision2.decision !== 'observe';
    const failOpenEligible =
      wantsRepairAgain &&
      decision2.riskLevel !== 'high' &&
      decision2.violations.every((v) => v.recoverability !== 'non_recoverable');
    if (failOpenEligible) {
      this.logger.warn(
        `[invokeReviewed] repair 上限用尽但仅剩 P1/P2 可恢复违规，fail-open 投递修复版: ` +
          `rules=${decision2.ruleIds.join(',') || '-'}, traceId=${ctx.traceId ?? '-'}`,
      );
    }
    // 确定性 repair 回归闸门（2026-07-24 审计 P1-5）：二审只判"修复版是否违规"，不比较
    // "相对首版是否退步"——结构压扁/结论反转的修复版曾带着二审 pass 直接投递
    // （trace batch_6a606ac5…）。检测需同时读取真实岗位证据，避免把删除幻觉岗位误判
    // 为退化。fence_stripped / envelope_unwrapped 是逐字剥离/提取，不可能回归，跳过检测
    // ——拆封产物相对信封原文本就是"结构骤变"，跑回归闸只会误报。
    const regression =
      deterministicRepairText === null
        ? detectRepairRegression(firstText, revisedText, {
            committedSideEffects: committed || undefined,
            jobEvidenceAvailable: this.resolveJobEvidenceAvailability(reviewedToolCalls),
            // 首审规则 id：本轮根本没调查岗工具时 jobEvidenceAvailable 是 undefined，
            // 逃生口够不着，只能靠"零证据类规则触发"这条判据识别"删幻觉 ≠ 结构塌缩"。
            triggeredRuleIds: decision.ruleIds,
          })
        : null;
    // 检出回归后的收敛对齐 guardrail-quality-system.md §2.3 ④：
    // 首版可 fail-open（P1/P2 全部可恢复且非高风险）→ 回退首版；
    // 首版不可 fail-open（P0/泄漏类/高风险）→ 两版都不投，静默 block 并留档——
    // 修复版已证明退化，首版又是守卫明确否决的泄漏/红线内容，谁都不能进投递链。
    // 注意不能用 violation.currentReplySendable 判定：revise 档一律派生为 false，
    // 会把"P1/P2 回退首版"整条路径变成不可达（2026-07-29 复审修正）。
    const regressionBlock = regression !== null && !this.isFirstReplyFailOpenEligible(decision);
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
    const finalDecision: OutputGuardDecision = regressionBlock
      ? {
          ...decision2,
          decision: 'block',
          riskLevel: decision.riskLevel,
          reasonCode: `repair_regression_blocked:${regression}`,
        }
      : wantsRepairAgain
        ? failOpenEligible
          ? { ...decision2, decision: 'pass', reasonCode: 'repair_exhausted_fail_open' }
          : { ...decision2, decision: 'block', reasonCode: 'repair_exhausted' }
        : regressionRevert
          ? { ...decision2, reasonCode: `repair_regression_reverted:${regression}` }
          : deterministicReasonCode !== null
            ? // 确定性剥围栏/拆信封放行：档案标注归因码，供守卫审计区分"LLM 重写"与"机械剥离"两类修复
              { ...decision2, reasonCode: decision2.reasonCode ?? deterministicReasonCode }
            : decision2;
    const finalResult = regressionBlock
      ? { ...revised, toolCalls: reviewedToolCalls }
      : wantsRepairAgain
        ? failOpenEligible && (this.isSecondDecisionWorse(decision, decision2) || regressionRevert)
          ? first
          : { ...revised, toolCalls: reviewedToolCalls }
        : regressionRevert
          ? first
          : { ...revised, toolCalls: reviewedToolCalls };
    const finalRevised = finalResult !== first;
    this.persistReviewRecord(ctx, {
      firstReply: firstText,
      firstDecision: decision,
      finalDecision,
      repaired: true,
      revisedReply: revisedText,
      revisedDecision: decision2,
      committedSideEffects: committed || undefined,
    });
    return this.finalizeReviewed(
      finalResult,
      finalDecision,
      finalRevised,
      wantDefer,
      this.buildGuardrailTrace(
        [firstStep, this.toGuardrailStep('revised', decision2)],
        true,
        finalDecision,
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
   * - 仅守卫有信号时写（非 pass 或有 rule 观测命中），放行回合不产生行；
   * - fire-and-forget：三态写入结果只用于观测告警，绝不阻塞/拖垮回复链路。
   */
  private persistReviewRecord(
    ctx: ReviewContext,
    data: {
      firstReply: string;
      firstDecision: OutputGuardDecision;
      finalDecision: OutputGuardDecision;
      repaired: boolean;
      revisedReply?: string;
      revisedDecision?: OutputGuardDecision;
      committedSideEffects?: string;
    },
  ): void {
    if (!ctx.traceId) return;
    const hasSignal =
      data.firstDecision.decision !== 'pass' || data.firstDecision.ruleIds.length > 0;
    if (!hasSignal) return;
    if (data.repaired && (data.revisedReply === undefined || !data.revisedDecision)) {
      this.logger.warn(`[invokeReviewed] 审查档案缺少修复后内容，跳过落库: traceId=${ctx.traceId}`);
      return;
    }

    // block 档案必须可归因（2026-07-06~08 生产曾落 46 条 null reason_code，复盘时
    // 无法区分拦截路径）：现行所有 block 分支都应显式携带 reasonCode，这里只兜历史
    // 上出现过的遗漏并告警，让回归在观测里现形而不是沉默落 null。
    let reasonCode = data.finalDecision.reasonCode;
    if (!reasonCode && data.finalDecision.decision === 'block') {
      reasonCode = 'unattributed_block';
      this.logger.warn(
        `[invokeReviewed] block 档案缺少 reasonCode，已兜底为 unattributed_block: ` +
          `traceId=${ctx.traceId}, rules=${data.finalDecision.blockedRuleIds.join(',') || '-'}`,
      );
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
      finalDecision: data.finalDecision.decision,
      reasonCode,
    };
    const reviewRecord: GuardrailReviewInsertInput = data.repaired
      ? {
          ...baseRecord,
          repairMode: data.firstDecision.repairMode,
          repaired: true,
          revisedReply: data.revisedReply,
          revised: this.toReviewStepDetail(data.revisedDecision),
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
            `err=${error instanceof Error ? error.message : String(error)}`,
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
    finalDecision: OutputGuardDecision,
  ): GuardrailTurnTrace {
    return {
      steps,
      repaired,
      finalDecision: finalDecision.decision,
      reasonCode: finalDecision.reasonCode,
    };
  }

  private isFirstReplyFailOpenEligible(decision: OutputGuardDecision): boolean {
    return (
      decision.riskLevel !== 'high' &&
      decision.violations.every((violation) => violation.recoverability !== 'non_recoverable')
    );
  }

  /**
   * 返回本轮查岗证据三态：
   * - true：至少一次 duliday_job_list 有正向成功信号/非空结果；
   * - false：调用过查岗，但没有一次返回可用岗位；
   * - undefined：本轮未调用查岗。
   *
   * 中间一次成功、随后复核为空时仍返回 true，和 review packet “优先取最后一次可用
   * 结果”的证据语义保持一致。
   */
  private resolveJobEvidenceAvailability(toolCalls: AgentToolCall[]): boolean | undefined {
    const jobListCalls = toolCalls.filter((call) => call.toolName === 'duliday_job_list');
    if (jobListCalls.length === 0) return undefined;
    return jobListCalls.some(
      (call) =>
        (typeof call.resultCount === 'number' && call.resultCount > 0) ||
        call.status === 'ok' ||
        call.status === 'narrow' ||
        isToolSuccess(call.result),
    );
  }

  private isOnlyInternalOutputLeakBlock(decision: OutputGuardDecision): boolean {
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
   * 领域合规前置（2026-07-30 审计 P0-3）：快通道的隐含前提是"围栏是这条回复唯一的
   * 问题"，而 2026-07-28 生产实例证明该前提会被整篇跨域内容击穿——候选人问日结岗，
   * 模型回了一整篇后端接口设计答案，剥完围栏词库不再命中，逐字放行投递给了候选人。
   * 剥离产物呈技术文档形态时不走快通道，交给常规 repair（该路径还会过回归闸）。
   */
  private tryStripFenceOnlyLeak(decision: OutputGuardDecision, text: string): string | null {
    if (!this.isOnlyInternalOutputLeakBlock(decision)) return null;
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

  /**
   * JSON 信封的确定性最小修复（2026-08-04 审计 P0-2）：不可发送命中仅为
   * internal_output_leak，且整条首版是"正文被包进 JSON 信封"的形态
   * （`{"agent_response":"好的，我帮你看下罗湖…"}`、`{"censorStatus":"ok","_replyInstruction":"不客气～…"}`）
   * → 拆出信封内正文逐字放行。生产实测该形态曾被残文判据误伤成整轮静默——
   * 字符串字面量剥离把好回复连壳一起剥掉了。
   *
   * 拆封判定（含 tool_use 结构键黑名单、唯一候选、正文自身无泄漏/非技术文档）
   * 收敛在 tryUnwrapEnvelopeReply；拆封产物仍走二审 + 悬空承接句检测，二审才是放行依据。
   */
  private tryUnwrapEnvelopeLeak(decision: OutputGuardDecision, text: string): string | null {
    if (!this.isOnlyInternalOutputLeakBlock(decision)) return null;
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
   * - `meta_narration_silenced`：元叙述旁白（badcase chat 6a5740ff…：真人经理接管期间
   *   模型输出"（AI 保持静默，不插入回复）"被投递）。模型本轮的真实意图就是不说话。
   * - `tool_call_artifact_silenced`：整条首版只是工具调用残文（2026-07-30 审计 P0-2，
   *   2026-07-28 15:05–15:11 模型降级窗口）。泄漏反馈要求"其余内容逐字保留"，而残文
   *   剥完无一字可留，rewrite 只能凭空创作——当时 4/4 例编出薪资/门店/伪造报名链接
   *   并全部投递。没有事实可依时，沉默是唯一安全的结局。
   * 混合命中其它规则时都不走捷径，仍按常规 repair 流程保守处理。
   */
  private resolveDirectSilenceReason(
    decision: OutputGuardDecision,
    firstText: string,
  ): string | null {
    if (decision.decision === 'block') {
      if (this.isOnlyMetaNarrationBlock(decision)) return 'meta_narration_silenced';
      if (this.isOnlyInternalOutputLeakBlock(decision) && isToolCallArtifactOnly(firstText)) {
        return 'tool_call_artifact_silenced';
      }
      return null;
    }
    return null;
  }

  private isOnlyMetaNarrationBlock(decision: OutputGuardDecision): boolean {
    return (
      decision.blockedRuleIds.length > 0 &&
      decision.blockedRuleIds.every((ruleId) => ruleId === 'meta_narration_reply')
    );
  }

  /**
   * fail-open 时修复版默认胜出（2026-07-24 审计 P1-3）。
   *
   * 旧判据是"首版 blocked 规则集完全复燃 → 弃修复版投首版"，把本窗口 10/16 的
   * fail-open 修复版丢回首版，其中多例修复版明确更优（结算口径精确化、删掉洗身份
   * 叙述）却被弃用，甚至致洗身份文本实际投递（trace batch_6a6190cd…）。同一规则
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
      // 与 invokeReviewed 的 firstText/revisedText 同口径：审查剥时间标记后的文本。
      reply: OutboundReplySanitizer.stripTimeMarkers((result.text ?? '').trim()),
      toolCalls,
      memorySnapshot: result.memorySnapshot,
      turnLedger: result.turnLedger,
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

  private async buildReplyRepairContext(
    ctx: ReviewContext,
  ): Promise<ReplyRepairContext | undefined> {
    if (!this.replyRepairContextProvider || !ctx.sessionRef) return undefined;
    try {
      return await this.replyRepairContextProvider.build({
        corpId: ctx.sessionRef.corpId,
        userId: ctx.sessionRef.userId,
        sessionId: ctx.sessionRef.sessionId,
        currentUserMessage: ctx.userMessage,
        shortTermEndTimeInclusive: ctx.shortTermEndTimeInclusive,
      });
    } catch (error) {
      this.logger.warn(
        `[invokeReviewed] reply repair 上下文读取失败: sessionId=${ctx.sessionRef.sessionId}, ` +
          `err=${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private buildRepairedResult(result: GeneratorRunResult, text: string): GeneratorRunResult {
    return {
      ...result,
      text,
      responseMessages: this.repairAssistantResponseMessages(result.responseMessages, text),
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
    const telemetryContext = {
      traceId: context?.messageId,
      chatId: sessionRef.sessionId,
      userId: sessionRef.userId,
      corpId: sessionRef.corpId,
      scenario:
        context?.scenario ?? (trigger.kind === 'proactive' ? trigger.scenarioCode : undefined),
      callerKind: context?.callerKind ?? CallerKind.WECOM,
    };

    const run = () => this.runTurnObserved(req);
    if (this.requestContext) {
      return this.requestContext.run(telemetryContext, run);
    }
    return run();
  }

  private async runTurnObserved(req: TurnRequest): Promise<TurnOutcome> {
    const startedAt = Date.now();
    this.tracer?.emit({ type: 'agent_start' });

    try {
      const outcome = await this.runTurnInternal(req);
      this.tracer?.emit({
        type: 'agent_end',
        steps: outcome.agentSteps?.length,
        totalTokens: outcome.usage?.totalTokens,
        durationMs: Date.now() - startedAt,
      });
      return outcome;
    } catch (error) {
      this.tracer?.emit({
        type: 'agent_error',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async runTurnInternal(req: TurnRequest): Promise<TurnOutcome> {
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
      hasNewerUserInput: context?.hasNewerUserInput,
      onPreparedRequest: context?.onPreparedRequest,
    };

    let result: ReviewedRunResult;
    try {
      result = await this.invokeReviewed(params, {
        sessionRef,
        userMessage: trigger.kind === 'inbound' ? trigger.userMessage : undefined,
        chatId: sessionRef.sessionId,
        userId: sessionRef.userId,
        traceId: context?.messageId,
        contactName: context?.contactName,
        botImId: context?.botImId,
        botUserName: context?.botUserId,
        shortTermEndTimeInclusive: context?.shortTermEndTimeInclusive,
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
        this.tracer?.emit({
          type: 'agent_error',
          error: err instanceof Error ? err.message : String(err),
        });
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

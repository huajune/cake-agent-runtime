import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AgentMemorySnapshot, AgentToolCall } from '@agent/generator/generator.types';
import { hasCommittedSideEffect } from '@agent/generator/tool-call-analysis';
import type {
  GuardVerdict,
  GuardViolation,
  GuardrailRiskLevel,
  OutputDecision,
} from '@shared-types/guardrail.contract';
import { HardRulesService } from './hard-rules.service';
import type { RuleContradiction } from './output-rule.types';
import { LlmReviewerService } from './llm-reviewer.service';

/**
 * 出站守卫组合器（§5.2 / §7）。
 *
 * 把确定性 rule 档与高风险才触发的 llm 档汇成一个最终裁决 `pass | revise | block`：
 * - rule 档（{@link HardRulesService}）：先跑、确定性、可硬 block（如歧视性筛选外露）；
 *   命中即由 rule 服务内部告警（飞书 badcase），行为与现状一致。
 * - llm 档（{@link LlmReviewerService}）：仅在高风险（含承诺/事实陈述，或紧跟副作用工具）
 *   且 `OUTPUT_GUARDRAIL_LLM_ENABLED=true` 时触发，带 grounding 审查语义/语气/意图。
 *
 * 切分铁律（§2.5）：rule = 能对齐 ground truth 的可机判模式；llm = 规则表达不了的语义。
 * 失败降级（§9）：reviewer 调用失败时按风险降级——高风险 block（不放行未审回复），低风险 fail-open。
 *
 * **flag 关闭时**（默认）：只有 rule 档生效，等价于现状——rule block→block、rule warn→pass+告警。
 */
@Injectable()
export class OutputGuardrailService {
  private readonly logger = new Logger(OutputGuardrailService.name);

  /** llm 档总开关（往实时回复链路加 LLM 调用需可灰度/可熔断）。 */
  private readonly llmEnabled: boolean;

  /** 触发 llm 档的"承诺/动态事实"措辞——纯寒暄/问位置不触发，控延迟成本。 */
  private static readonly COMMITMENT_OR_FACT_PATTERN =
    /约好|约上|名额|留着|已帮你|已为你|帮你预约|已预约|已报名|双倍|日结|周结|月结|公里|班次|早班|晚班|包吃|包住|五险|社保/;

  constructor(
    private readonly configService: ConfigService,
    private readonly ruleGuard: HardRulesService,
    private readonly llmReviewer: LlmReviewerService,
  ) {
    this.llmEnabled = this.configService.get('OUTPUT_GUARDRAIL_LLM_ENABLED', 'false') === 'true';
    if (this.llmEnabled) {
      this.logger.log('[OutputGuardrail] llm 档已启用（高风险回复将触发 LlmReviewer）');
    }
  }

  /**
   * 审查一条候选回复，返回组合裁决。
   *
   * 不变量：只读、无副作用；决策是 veto（pass/revise/block），不改写文本（revise 的重写
   * 由 runner 带 violations 重新生成）。
   */
  async check(input: OutputGuardInput): Promise<OutputGuardDecision> {
    const reply = input.reply?.trim() ?? '';
    if (!reply) {
      return {
        decision: 'pass',
        riskLevel: 'low',
        violations: [],
        ruleIds: [],
        blockedRuleIds: [],
      };
    }

    // ---- rule 档（确定性，先跑；内部已做飞书告警） ----
    const ruleResult = this.ruleGuard.check({
      replyText: reply,
      toolCalls: input.toolCalls,
      chatId: input.chatId,
      userId: input.userId,
      traceId: input.traceId,
      contactName: input.contactName,
      botImId: input.botImId,
      botUserName: input.botUserName,
      userMessage: input.userMessage,
    });
    const ruleIds = ruleResult.contradictions.map((c) => c.ruleId);
    const blockedRuleIds = ruleResult.contradictions
      .filter((c) => c.action === 'block')
      .map((c) => c.ruleId);
    const reviseRuleIds = ruleResult.contradictions
      .filter((c) => c.action === 'revise')
      .map((c) => c.ruleId);

    // rule 硬 block（如歧视性筛选外露）：发出去不可挽回，直接 block，不必再问 llm。
    if (blockedRuleIds.length > 0) {
      return {
        decision: 'block',
        riskLevel: 'high',
        violations: ruleResult.contradictions
          .filter((c) => c.action === 'block')
          .map((c) => this.ruleToViolation(c.ruleId, c.label)),
        ruleIds,
        blockedRuleIds,
      };
    }

    // ---- llm 档（高风险才触发；flag 关闭时直接放行，等价现状） ----
    const llmTrigger = this.resolveLlmTrigger(reply, input.toolCalls);
    if (!this.llmEnabled || llmTrigger === 'none') {
      if (reviseRuleIds.length > 0) {
        return {
          decision: 'revise',
          riskLevel: 'medium',
          violations: ruleResult.contradictions
            .filter((c) => c.action === 'revise')
            .map((c) => this.ruleToViolation(c.ruleId, c.label)),
          ruleIds,
          blockedRuleIds,
        };
      }
      // observe 规则保持 Phase 1 语义：仅告警、不拦截。
      return { decision: 'pass', riskLevel: 'low', violations: [], ruleIds, blockedRuleIds };
    }

    const ruleViolations = ruleResult.contradictions.map((c) =>
      this.ruleToViolation(c.ruleId, c.label),
    );

    let llmDecision: OutputGuardDecision['decision'] = 'pass';
    let llmRisk: GuardrailRiskLevel = 'low';
    let llmViolations: GuardViolation[] = [];
    try {
      const verdict = await this.llmReviewer.review({
        reply,
        toolCalls: input.toolCalls,
        memorySnapshot: input.memorySnapshot,
        redLines: input.redLines ?? [],
        userMessage: input.userMessage,
      });
      llmDecision = verdict.decision;
      llmRisk = verdict.riskLevel;
      llmViolations = verdict.violations;
    } catch (error) {
      // §9 降级：能走到 reviewer 的都是高风险候选回复；reviewer 故障时不放行未审回复。
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `[OutputGuardrail] reviewer 故障且回复触发高风险审查(${llmTrigger})，按高风险 block: ${message}`,
      );
      return {
        decision: 'block',
        riskLevel: 'high',
        violations: ruleViolations,
        ruleIds,
        blockedRuleIds,
        reasonCode: 'output_review_unavailable',
      };
    }

    // 汇总：rule 命中 + llm 裁决，取更严重者。
    const decision = this.mergeDecision(llmDecision, ruleResult.contradictions);
    return {
      decision,
      riskLevel: llmRisk,
      violations: [...ruleViolations, ...llmViolations],
      ruleIds,
      blockedRuleIds,
    };
  }

  /**
   * 是否触发 llm 档。两档区分「已提交副作用」与「尝试过副作用」：
   * - `side_effect`：本轮**成功提交**过任一副作用工具（{@link isToolSuccess}）——既成事实不可撤销，
   *   无论文案如何都强制审查。
   * - 失败/无副作用的尝试（如 request_handoff 返回 dispatched:false、booking 失败回执）**不**单凭
   *   工具名触发审查；仅当回复本身含承诺/事实措辞时才走 `commitment_or_fact` 档。
   *
   * 这样可避免 no-op 副作用尝试在 reviewer 故障时被误判高风险 block（§9 降级）。
   */
  private resolveLlmTrigger(
    reply: string,
    toolCalls: AgentToolCall[],
  ): 'none' | 'side_effect' | 'commitment_or_fact' {
    if (hasCommittedSideEffect(toolCalls)) return 'side_effect';
    return OutputGuardrailService.COMMITMENT_OR_FACT_PATTERN.test(reply)
      ? 'commitment_or_fact'
      : 'none';
  }

  /** rule action 与 llm 裁决合并：block > revise > pass。 */
  private mergeDecision(
    llmDecision: OutputGuardDecision['decision'],
    rules: RuleContradiction[],
  ): OutputGuardDecision['decision'] {
    if (llmDecision === 'block') return 'block';
    if (rules.some((c) => c.action === 'revise')) return 'revise';
    return llmDecision;
  }

  /** 把 rule 命中映射成 GuardViolation（用于 revise 回路喂回意见）。 */
  private ruleToViolation(ruleId: string, label: string): GuardViolation {
    return { type: ruleId, evidence: label, suggestion: `修正以消除「${ruleId}」命中的问题` };
  }
}

export interface OutputGuardInput {
  reply: string;
  toolCalls: AgentToolCall[];
  memorySnapshot?: AgentMemorySnapshot;
  redLines?: string[];
  userMessage?: string;
  /** 透传给 rule 档做飞书告警/观测的上下文。 */
  chatId?: string;
  userId?: string;
  traceId?: string;
  contactName?: string;
  botImId?: string;
  botUserName?: string;
}

export interface OutputGuardDecision extends GuardVerdict {
  decision: OutputDecision;
  riskLevel: GuardrailRiskLevel;
  violations: GuardViolation[];
  /** 本轮命中的全部 rule id（含非 block，供观测）。 */
  ruleIds: string[];
  /** 触发硬 block 的 rule id。 */
  blockedRuleIds: string[];
  /** 降级/转人工归因码。 */
  reasonCode?: string;
}

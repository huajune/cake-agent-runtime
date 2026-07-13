import { Injectable, Logger } from '@nestjs/common';
import { RouterService } from '@providers/router.service';
import { ModelRole } from '@/llm/llm.types';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { ShortTermService } from '@memory/services/short-term.service';
import { SemanticReviewNotifierService } from '@notification/services/semantic-review-notifier.service';
import type { AgentMemorySnapshot, AgentToolCall } from '@agent/generator/generator.types';
import { hasCommittedSideEffect } from '@agent/generator/tool-call-analysis';
import type {
  GuardViolation,
  GuardrailRepairMode,
  GuardrailRiskLevel,
  OutputDecision,
} from '@shared-types/guardrail.contract';
import type { GuardrailPriority } from '@shared-types/guardrail.contract';
import {
  GUARDRAIL_DECISION,
  GUARDRAIL_FEEDBACK_POLICY,
  GUARDRAIL_PRIORITY,
  GUARDRAIL_RECOVERABILITY,
  GUARDRAIL_REPAIR_MODE,
  GUARDRAIL_RISK_LEVEL,
} from '@shared-types/guardrail.contract';
import { HardRulesService } from './hard-rules.service';
import type { RuleContradiction } from './output-rule.types';
import { GuardrailReviewPacketBuilder } from './llm/review-packet.builder';
import {
  SEMANTIC_REVIEW_FINDING_POLICIES,
  SemanticReviewerService,
  type SemanticReviewVerdict,
} from './llm/semantic-reviewer.service';
import type { GuardrailReviewPacket } from './llm/review-packet.types';

/**
 * 出站守卫组合器（§5.2 / §7）。
 *
 * 把确定性 rule 档与高风险才触发的 llm 档汇成一个最终裁决 `pass | revise | replan | block`：
 * - rule 档（{@link HardRulesService}）：先跑、确定性、可 veto 当前回复；
 *   enforce 命中由 rule 服务内部告警，observe 只落 `guardrail_review_records`。
 * - llm 档（{@link SemanticReviewerService}）：唯一的语义 reviewer，吃
 *   {@link GuardrailReviewPacketBuilder} 裁剪出的证据包，输出领域 finding。
 *   触发条件：本轮成功提交过副作用工具 / 回复含承诺·动态事实措辞 / 命中语义 contract 触发词。
 *
 * 切分铁律（§2.5）：rule = 能对齐 ground truth 的可机判模式；llm = 规则表达不了的语义。
 * LLM 不能自证（redesign §4.1）：reviewer 只能基于证据包裁决；低置信 enforce 结论在代码层
 * 强制降级为 observe，不允许"凭感觉 block"。
 * 失败降级（§9）：高风险触发（副作用/承诺事实）时 reviewer 故障 fail-close（block）；
 * 仅语义 contract 触发时 fail-open，回退 rule 档裁决。
 *
 * 灰度：两个开关挂在托管配置 `agent_reply_config`（Dashboard 运行时配置页即时生效，
 * 环境变量 `OUTPUT_GUARDRAIL_LLM_ENABLED` / `OUTPUT_GUARDRAIL_SEMANTIC_SHADOW_ENABLED`
 * 仅作 DB 未持久化时的 bootstrap 默认值）：
 * - `outputGuardrailLlmEnabled` 开启后 reviewer 结论参与裁决（enforce）；
 * - `outputGuardrailSemanticShadowEnabled` 在未 enforce 时 fire-and-forget 只观测。
 * 两个都关（默认）：只有 rule 档生效；可恢复 veto 会先进受控 repair loop。
 * 观测不落日志洞：shadow/enforce/低置信降级判例写飞书 badcase 多维表，
 * reviewer 故障走 ops 告警（fail-close error 级 / fail-open+shadow warning 级）。
 */
/** 传给 rule 档做跨轮豁免的候选人消息条数（覆盖"上轮问、本轮追问"的短跨度语境）。 */
const RECENT_USER_TEXTS_LIMIT = 3;

@Injectable()
export class OutputGuardrailService {
  private readonly logger = new Logger(OutputGuardrailService.name);

  /** 触发 llm 档的"承诺/动态事实"措辞——纯寒暄/问位置不触发，控延迟成本。 */
  private static readonly COMMITMENT_OR_FACT_PATTERN =
    /约好|约上|名额|留着|已帮你|已为你|帮你预约|已预约|已报名|双倍|日结|周结|月结|公里|班次|早班|晚班|包吃|包住|五险|社保/;

  /** review 模型缺配时只告警一次/进程，避免每条消息刷屏（飞书侧另有 dedupe）。 */
  private reviewModelMissingWarned = false;

  constructor(
    private readonly systemConfig: SystemConfigService,
    private readonly ruleGuard: HardRulesService,
    private readonly packetBuilder: GuardrailReviewPacketBuilder,
    private readonly semanticReviewer: SemanticReviewerService,
    private readonly semanticNotifier: SemanticReviewNotifierService,
    private readonly shortTerm: ShortTermService,
    private readonly router: RouterService,
  ) {}

  /**
   * 读取本会话短期历史（单次远程读取，assistant/user 两用）：
   * - assistant 文本：repeated_reply 的外生信号；
   * - 最近几条 user 文本：跨轮豁免信号（如候选人上轮问了社保、本轮 Agent 作答）。
   * 读取失败按空降级——这些是质量规则信号，不能因 Redis 抖动挡住出站链路。
   */
  private async readRecentTexts(
    chatId: string | undefined,
  ): Promise<{ assistantTexts: string[]; userTexts: string[] }> {
    if (!chatId) return { assistantTexts: [], userTexts: [] };
    try {
      const messages = await this.shortTerm.getMessages(chatId);
      const assistantTexts = messages
        .filter((message) => message.role === 'assistant' && message.content.trim().length > 0)
        .map((message) => message.content);
      const userTexts = messages
        .filter((message) => message.role === 'user' && message.content.trim().length > 0)
        .map((message) => message.content)
        .slice(-RECENT_USER_TEXTS_LIMIT);
      return { assistantTexts, userTexts };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[OutputGuardrail] 读取会话历史失败，跳过重复输出对账: ${message}`);
      return { assistantTexts: [], userTexts: [] };
    }
  }

  /**
   * llm 档开关按次读取托管配置（Dashboard 运行时配置页即时生效，支撑灰度上量与紧急熔断）。
   * SystemConfigService 内置 1s 本地热缓存 → Redis → DB → 环境变量默认值，读取不抛错。
   */
  private async resolveLlmFlags(): Promise<{ llmEnabled: boolean; shadowEnabled: boolean }> {
    const config = await this.systemConfig.getAgentReplyConfig();
    let llmEnabled = config.outputGuardrailLlmEnabled;
    let shadowEnabled = config.outputGuardrailSemanticShadowEnabled;

    // 前置条件校验：llm/shadow 档依赖 AGENT_REVIEW_MODEL（review 角色）。Dashboard 开关
    // 即时生效，但缺模型时 reviewer 必抛错——高危触发词场景会 fail-close 成 block，
    // 把"已约成功"这类确认话术整轮吞掉。此处按"档位未生效"降级为纯 rule 档并告警。
    if ((llmEnabled || shadowEnabled) && !this.router.getModelIdByRole(ModelRole.Review)) {
      if (!this.reviewModelMissingWarned) {
        this.reviewModelMissingWarned = true;
        this.logger.error(
          '[OutputGuardrail] llm/shadow 档已在托管配置开启，但 AGENT_REVIEW_MODEL 未配置——' +
            '语义档按未开启降级（纯 rule 档），请配置模型或关闭 Dashboard 开关',
        );
        void this.semanticNotifier
          .notifyReviewerFailure({
            failMode: 'fail_open',
            error: 'AGENT_REVIEW_MODEL 未配置，语义档开关已降级为未开启（纯 rule 档）',
          })
          .catch(() => undefined);
      }
      llmEnabled = false;
      shadowEnabled = false;
    }

    return { llmEnabled, shadowEnabled };
  }

  /**
   * 审查一条候选回复，返回组合裁决。
   *
   * 不变量：只读、无副作用；决策是 veto（pass/revise/replan/block），不改写文本（revise 的
   * 重写由 runner 带 violations 重新生成）。
   */
  async check(input: OutputGuardInput): Promise<OutputGuardDecision> {
    const reply = input.reply?.trim() ?? '';
    if (!reply) {
      return {
        decision: GUARDRAIL_DECISION.PASS,
        riskLevel: GUARDRAIL_RISK_LEVEL.LOW,
        violations: [],
        ruleIds: [],
        blockedRuleIds: [],
        repairMode: GUARDRAIL_REPAIR_MODE.REWRITE,
      };
    }

    // ---- rule 档（确定性，先跑；内部已做飞书告警） ----
    const { assistantTexts: recentAssistantTexts, userTexts: recentUserTexts } =
      await this.readRecentTexts(input.chatId);
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
      recentAssistantTexts,
      recentUserTexts,
      silent: input.silent,
    });
    const ruleIds = ruleResult.contradictions.map((c) => c.ruleId);
    // 不可发送的规则（revise / replan / block），action=observe 的内容仍可发出。
    const blockedRuleIds = ruleResult.contradictions
      .filter((c) => c.currentReplySendable === false)
      .map((c) => c.ruleId);

    // 按优先级聚合 rule 档决策：block > replan > revise > observe > pass
    const ruleDecision = this.mergeRuleDecision(ruleResult.contradictions);

    // packet 只裁剪本轮已有信息（同步、无 IO），shadow 与 enforce 共用同一份证据。
    const packet = this.packetBuilder.build({
      reply,
      toolCalls: input.toolCalls,
      userMessage: input.userMessage,
      redLines: input.redLines,
      outputRuleHits: ruleIds,
    });

    const flags = await this.resolveLlmFlags();

    if (ruleDecision === GUARDRAIL_DECISION.BLOCK) {
      this.runSemanticShadow(packet, flags, input);
      return {
        decision: GUARDRAIL_DECISION.BLOCK,
        riskLevel: GUARDRAIL_RISK_LEVEL.HIGH,
        violations: ruleResult.contradictions
          .filter((c) => c.currentReplySendable === false)
          .map((c) => this.ruleToViolation(c)),
        ruleIds,
        blockedRuleIds,
        repairMode: GUARDRAIL_REPAIR_MODE.REWRITE,
      };
    }

    // ---- llm 档（高风险或语义 contract 触发；enforce flag 关闭时最多 shadow） ----
    const highRiskTrigger = this.resolveHighRiskTrigger(reply, input.toolCalls);
    const semanticTrigger = this.semanticReviewer.shouldReview(packet);
    const shouldEnforce = flags.llmEnabled && (highRiskTrigger !== 'none' || semanticTrigger);

    if (!shouldEnforce) {
      this.runSemanticShadow(packet, flags, input);
      return this.ruleOnlyDecision(
        ruleDecision,
        ruleResult.contradictions,
        ruleIds,
        blockedRuleIds,
      );
    }

    let verdict: SemanticReviewVerdict;
    try {
      verdict = await this.semanticReviewer.review(packet);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (highRiskTrigger !== 'none') {
        // §9 降级：副作用既成/承诺事实回复不放行未审版本，fail-close。
        this.logger.error(
          `[OutputGuardrail] reviewer 故障且回复触发高风险审查(${highRiskTrigger})，按高风险 block: ${message}`,
        );
        if (!input.silent) {
          void this.semanticNotifier
            .notifyReviewerFailure({
              failMode: 'fail_close',
              error: message,
              chatId: input.chatId,
              userId: input.userId,
              contactName: input.contactName,
              replyPreview: reply.slice(0, 200),
            })
            .catch(() => undefined);
        }
        return {
          decision: GUARDRAIL_DECISION.BLOCK,
          riskLevel: GUARDRAIL_RISK_LEVEL.HIGH,
          violations: ruleResult.contradictions.map((c) => this.ruleToViolation(c)),
          ruleIds,
          blockedRuleIds,
          reasonCode: 'output_review_unavailable',
          repairMode: GUARDRAIL_REPAIR_MODE.REWRITE,
        };
      }
      // 仅语义 contract 触发（体验/推荐质量类）：fail-open，回退 rule 档裁决。
      this.logger.warn(`[OutputGuardrail] semantic reviewer 故障，语义档 fail-open: ${message}`);
      if (!input.silent) {
        void this.semanticNotifier
          .notifyReviewerFailure({
            failMode: 'fail_open',
            error: message,
            chatId: input.chatId,
            userId: input.userId,
            contactName: input.contactName,
          })
          .catch(() => undefined);
      }
      return this.ruleOnlyDecision(
        ruleDecision,
        ruleResult.contradictions,
        ruleIds,
        blockedRuleIds,
      );
    }

    // LLM 不能自证：低置信的 enforce 结论强制降级为 observe，只留观测。
    const llmDecision = this.applyConfidenceBackstop(verdict);
    const llmViolations = verdict.findings.map((finding) => this.findingToViolation(finding));

    // 汇总：rule 档 + llm 档，按优先级取更严重者。
    const decision = this.mergeByPriority(ruleDecision, llmDecision);
    const actionableRules = ruleResult.contradictions.filter(
      (c) => c.currentReplySendable === false,
    );
    const enforcedLlm =
      llmDecision === GUARDRAIL_DECISION.REVISE ||
      llmDecision === GUARDRAIL_DECISION.REPLAN ||
      llmDecision === GUARDRAIL_DECISION.BLOCK;
    // 判例上报：enforce 拦截与低置信降级都是灰度评估样本，fire-and-forget 写 badcase 表。
    const confidenceDowngraded = llmDecision !== (verdict.decision as OutputDecision);
    if (!input.silent) {
      if (confidenceDowngraded) {
        void this.notifyVerdict('confidence_downgraded', verdict, reply, input);
      } else if (enforcedLlm) {
        void this.notifyVerdict('enforce', verdict, reply, input);
      }
    }
    const feedbackLines = [
      this.buildFeedbackToGenerator(actionableRules),
      enforcedLlm
        ? verdict.findings
            .map((finding) => finding.feedbackToGenerator?.trim())
            .filter(Boolean)
            .join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    return {
      decision,
      riskLevel: this.resolveLlmRiskLevel(
        llmDecision,
        actionableRules,
        enforcedLlm ? llmViolations : [],
      ),
      violations: [
        ...actionableRules.map((c) => this.ruleToViolation(c)),
        ...(enforcedLlm ? llmViolations : []),
      ],
      ruleIds,
      blockedRuleIds,
      repairMode:
        decision === GUARDRAIL_DECISION.REPLAN
          ? GUARDRAIL_REPAIR_MODE.REPLAN
          : GUARDRAIL_REPAIR_MODE.REWRITE,
      repairToolNames: this.resolveRepairToolNames(
        actionableRules,
        enforcedLlm ? verdict.findings : [],
      ),
      feedbackToGenerator: feedbackLines || undefined,
    };
  }

  /** flag 关闭 / 未触发 llm 档时的纯 rule 裁决（等价旧行为）。 */
  private ruleOnlyDecision(
    ruleDecision: OutputDecision,
    contradictions: RuleContradiction[],
    ruleIds: string[],
    blockedRuleIds: string[],
  ): OutputGuardDecision {
    if (ruleDecision === GUARDRAIL_DECISION.REPLAN || ruleDecision === GUARDRAIL_DECISION.REVISE) {
      const repairMode =
        ruleDecision === GUARDRAIL_DECISION.REPLAN
          ? GUARDRAIL_REPAIR_MODE.REPLAN
          : GUARDRAIL_REPAIR_MODE.REWRITE;
      const actionableRules = contradictions.filter((c) => c.currentReplySendable === false);
      return {
        decision: ruleDecision,
        riskLevel: this.resolveRuleRiskLevel(actionableRules),
        violations: actionableRules.map((c) => this.ruleToViolation(c)),
        ruleIds,
        blockedRuleIds,
        repairMode,
        repairToolNames: this.resolveRepairToolNames(actionableRules, []),
        feedbackToGenerator: this.buildFeedbackToGenerator(actionableRules),
      };
    }
    // observe 或 pass：仅告警、不拦截。
    return {
      decision: GUARDRAIL_DECISION.PASS,
      riskLevel: GUARDRAIL_RISK_LEVEL.LOW,
      violations: [],
      ruleIds,
      blockedRuleIds,
      repairMode: GUARDRAIL_REPAIR_MODE.REWRITE,
    };
  }

  /**
   * 未 enforce 时的 shadow 观测：fire-and-forget，不影响裁决、不阻塞回复链路。
   * 命中判例写飞书 badcase 表（灰度期评估 precision 的原材料），失败走 ops 告警。
   */
  private runSemanticShadow(
    packet: GuardrailReviewPacket,
    flags: { llmEnabled: boolean; shadowEnabled: boolean },
    input: OutputGuardInput,
  ): void {
    // silent（advisory 调试流量）：不跑 shadow，避免污染灰度 badcase 判例池。
    if (input.silent) return;
    if (!flags.shadowEnabled || flags.llmEnabled) return;
    if (!this.semanticReviewer.shouldReview(packet)) return;

    void this.semanticReviewer
      .review(packet)
      .then(async (verdict) => {
        const findingCodes = verdict.findings.map((finding) => finding.code).join(',') || '-';
        this.logger.log(
          `[OutputGuardrail] semantic shadow: decision=${verdict.decision}, confidence=${verdict.confidence}, findings=${findingCodes}`,
        );
        if (verdict.decision !== GUARDRAIL_DECISION.PASS || verdict.findings.length > 0) {
          await this.notifyVerdict('shadow', verdict, packet.draftReply, input);
        }
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[OutputGuardrail] semantic shadow reviewer failed: ${message}`);
        await this.semanticNotifier
          .notifyReviewerFailure({
            failMode: 'shadow',
            error: message,
            chatId: input.chatId,
            userId: input.userId,
            contactName: input.contactName,
          })
          .catch(() => undefined);
      });
  }

  /** 语义判例上报（badcase 多维表）；通知失败只记日志，不影响裁决链路。 */
  private async notifyVerdict(
    mode: 'shadow' | 'enforce' | 'confidence_downgraded',
    verdict: SemanticReviewVerdict,
    reply: string,
    input: OutputGuardInput,
  ): Promise<void> {
    await this.semanticNotifier
      .notifyVerdict({
        mode,
        decision: verdict.decision,
        confidence: verdict.confidence,
        findings: verdict.findings.map((finding) => ({
          code: finding.code,
          evidenceQuote: finding.evidenceQuote,
          userImpact: finding.userImpact,
          feedbackToGenerator: finding.feedbackToGenerator,
        })),
        replyPreview: reply.slice(0, 400),
        userMessage: input.userMessage,
        chatId: input.chatId,
        userId: input.userId,
        traceId: input.traceId,
        contactName: input.contactName,
        botUserName: input.botUserName,
      })
      .catch(() => undefined);
  }

  /**
   * 高风险触发档。两档区分「已提交副作用」与「尝试过副作用」：
   * - `side_effect`：本轮**成功提交**过任一副作用工具（{@link isToolSuccess}）——既成事实不可撤销，
   *   无论文案如何都强制审查。
   * - 失败/无副作用的尝试（如 request_handoff 返回 dispatched:false、booking 失败回执）**不**单凭
   *   工具名触发审查；仅当回复本身含承诺/事实措辞时才走 `commitment_or_fact` 档。
   *
   * 这样可避免 no-op 副作用尝试在 reviewer 故障时被误判高风险 block（§9 降级）。
   */
  private resolveHighRiskTrigger(
    reply: string,
    toolCalls: AgentToolCall[],
  ): 'none' | 'side_effect' | 'commitment_or_fact' {
    if (hasCommittedSideEffect(toolCalls)) return 'side_effect';
    return OutputGuardrailService.COMMITMENT_OR_FACT_PATTERN.test(reply)
      ? 'commitment_or_fact'
      : 'none';
  }

  /**
   * "LLM 不能自证"的代码层兜底：reviewer 自评 confidence=low 时，enforce 级结论
   * （revise/replan/block）一律降级为 observe——证据不足只能观测，不能拦截。
   */
  private applyConfidenceBackstop(verdict: SemanticReviewVerdict): OutputDecision {
    const decision = verdict.decision as OutputDecision;
    const isEnforce =
      decision === GUARDRAIL_DECISION.REVISE ||
      decision === GUARDRAIL_DECISION.REPLAN ||
      decision === GUARDRAIL_DECISION.BLOCK;
    if (isEnforce && verdict.confidence === 'low') {
      this.logger.warn(
        `[OutputGuardrail] semantic reviewer 低置信 ${decision} 降级为 observe: findings=${verdict.findings
          .map((f) => f.code)
          .join(',')}`,
      );
      return GUARDRAIL_DECISION.OBSERVE;
    }
    return decision;
  }

  private mergeRuleDecision(contradictions: RuleContradiction[]): OutputDecision {
    const actions = contradictions.map((c) => c.action);
    if (actions.includes('block')) return GUARDRAIL_DECISION.BLOCK;
    if (actions.includes('replan')) return GUARDRAIL_DECISION.REPLAN;
    if (actions.includes('revise')) return GUARDRAIL_DECISION.REVISE;
    if (actions.includes('observe')) return GUARDRAIL_DECISION.OBSERVE;
    return GUARDRAIL_DECISION.PASS;
  }

  private mergeByPriority(a: OutputDecision, b: OutputDecision): OutputDecision {
    const PRIORITY: OutputDecision[] = ['block', 'replan', 'revise', 'observe', 'pass'];
    return PRIORITY.find((d) => d === a || d === b) ?? GUARDRAIL_DECISION.PASS;
  }

  /** 把 rule 命中映射成 GuardViolation（用于 revise 回路喂回意见）。 */
  private ruleToViolation(rule: RuleContradiction): GuardViolation {
    return {
      type: rule.ruleId,
      evidence:
        rule.feedbackPolicy === GUARDRAIL_FEEDBACK_POLICY.REDACTED
          ? '命中高敏感出站规则，证据已脱敏'
          : rule.label,
      suggestion:
        rule.feedbackToGenerator?.trim() ||
        `修正以消除「${rule.ruleId}」命中的问题，只输出候选人可见回复`,
      severity: rule.severity,
      dataSensitivity: rule.dataSensitivity,
      recoverability: rule.recoverability,
      currentReplySendable: rule.currentReplySendable,
      feedbackPolicy: rule.feedbackPolicy,
      repairMode: rule.repairMode,
    };
  }

  /**
   * 语义 finding 的风险优先级。booking 状态冲突与 rule 档"工具失败假成功/预检阻断仍承诺"
   * 同属 P0 域（发出去即误导候选人预约状态，不可挽回）；品牌/地理歧义是强业务风险 P1；
   * 推荐非最优是质量问题 P2。该优先级经 resolveLlmRiskLevel 传导到 riskLevel，
   * 决定 repair 上限用尽后能否 fail-open（runner §9）。
   */
  private static readonly SEMANTIC_FINDING_SEVERITY: Record<
    SemanticReviewVerdict['findings'][number]['code'],
    GuardrailPriority
  > = {
    job_recommendation_not_best_supported: GUARDRAIL_PRIORITY.P2,
    brand_or_geo_ambiguity_ignored: GUARDRAIL_PRIORITY.P1,
    active_booking_state_conflict: GUARDRAIL_PRIORITY.P0,
  };

  private resolveRepairToolNames(
    rules: RuleContradiction[],
    findings: SemanticReviewVerdict['findings'],
  ): string[] {
    const names = new Set<string>();
    for (const rule of rules) {
      if (rule.repairMode !== GUARDRAIL_REPAIR_MODE.REPLAN) continue;
      for (const name of rule.repairToolNames ?? []) names.add(name);
    }
    for (const finding of findings) {
      if (finding.repairMode !== GUARDRAIL_REPAIR_MODE.REPLAN) continue;
      for (const name of SEMANTIC_REVIEW_FINDING_POLICIES[finding.code].repairToolNames) {
        names.add(name);
      }
    }
    return [...names];
  }

  /** 把 semantic finding 映射成 GuardViolation（喂回 repair prompt）。 */
  private findingToViolation(finding: SemanticReviewVerdict['findings'][number]): GuardViolation {
    return {
      type: finding.code,
      evidence: finding.evidencePath
        ? `${finding.evidenceQuote}（证据: ${finding.evidencePath}）`
        : finding.evidenceQuote,
      suggestion:
        finding.feedbackToGenerator?.trim() ||
        `修正以消除「${finding.code}」问题，只输出候选人可见回复`,
      severity:
        OutputGuardrailService.SEMANTIC_FINDING_SEVERITY[finding.code] ?? GUARDRAIL_PRIORITY.P1,
      // 语义 finding 只经 revise/replan 进入 violations（block 在上游即收敛为最终裁决），
      // 按定义可改写修复；P0 finding 禁 fail-open 的信号由 severity → riskLevel 承载，
      // 不能留 undefined——runner 的 fail-open 闸门按 !== 'non_recoverable' 判定。
      recoverability: GUARDRAIL_RECOVERABILITY.RECOVERABLE,
      repairMode:
        finding.repairMode === 'replan'
          ? GUARDRAIL_REPAIR_MODE.REPLAN
          : GUARDRAIL_REPAIR_MODE.REWRITE,
    };
  }

  private resolveRuleRiskLevel(rules: RuleContradiction[]): GuardrailRiskLevel {
    if (rules.some((rule) => rule.severity === GUARDRAIL_PRIORITY.P0)) {
      return GUARDRAIL_RISK_LEVEL.HIGH;
    }
    if (rules.some((rule) => rule.severity === GUARDRAIL_PRIORITY.P1)) {
      return GUARDRAIL_RISK_LEVEL.MEDIUM;
    }
    return GUARDRAIL_RISK_LEVEL.LOW;
  }

  /**
   * llm 档参与裁决时的组合 riskLevel。
   *
   * revise/replan 不能短路成 medium：riskLevel=high 是 runner §9 repair 上限用尽后
   * 禁止 fail-open 的唯一档位信号。rule 档 P0（如工具失败假成功，action=revise 但
   * severity=P0）或语义档 P0 finding 命中时必须传导 high，否则语义档恰好同轮 revise
   * 会把 P0 违规"洗"成 medium → repair 两轮未净即 fail-open 发出（2026-07-06 review Critical）。
   */
  private resolveLlmRiskLevel(
    llmDecision: OutputDecision,
    actionableRules: RuleContradiction[],
    enforcedLlmViolations: GuardViolation[],
  ): GuardrailRiskLevel {
    if (llmDecision === GUARDRAIL_DECISION.BLOCK) return GUARDRAIL_RISK_LEVEL.HIGH;
    const ruleLevel = this.resolveRuleRiskLevel(actionableRules);
    if (llmDecision === GUARDRAIL_DECISION.REVISE || llmDecision === GUARDRAIL_DECISION.REPLAN) {
      const hasP0 =
        ruleLevel === GUARDRAIL_RISK_LEVEL.HIGH ||
        enforcedLlmViolations.some((v) => v.severity === GUARDRAIL_PRIORITY.P0);
      return hasP0 ? GUARDRAIL_RISK_LEVEL.HIGH : GUARDRAIL_RISK_LEVEL.MEDIUM;
    }
    return ruleLevel;
  }

  private buildFeedbackToGenerator(rules: RuleContradiction[]): string {
    return rules
      .map((rule) => rule.feedbackToGenerator?.trim())
      .filter((line): line is string => Boolean(line))
      .join('\n');
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
  /**
   * 静默模式（advisory）：只返回裁决，不 fire 任何告警/判例上报（飞书 badcase、语义 verdict、
   * reviewer 故障告警）。用于调试流量在流末 advisory 展示"守卫会怎么判"，避免污染生产 badcase 池。
   */
  silent?: boolean;
}

export interface OutputGuardDecision {
  decision: OutputDecision;
  riskLevel: GuardrailRiskLevel;
  violations: GuardViolation[];
  /** 本轮命中的全部 rule id（含非 block，供观测）。 */
  ruleIds: string[];
  /** 当前回复不可发送的 rule id。最终是否 block 由 recoverability 与 repair 上限决定。 */
  blockedRuleIds: string[];
  /** 本次修复建议：rewrite=无工具重写，replan=按命中规则的精确工具白名单重新规划。 */
  repairMode: GuardrailRepairMode;
  /** 守卫声明的最小修复工具集合；runner 只执行，不解析 ruleId/finding code。 */
  repairToolNames?: string[];
  /** 聚合后的脱敏/普通反馈，直接进入 generator repair prompt。 */
  feedbackToGenerator?: string;
  /** 降级/转人工归因码。 */
  reasonCode?: string;
}

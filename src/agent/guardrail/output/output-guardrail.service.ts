import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { SessionFactsService } from '@memory/short-term/facts.service';
import { MessageWindowService } from '@memory/short-term/message-window.service';
import { LongTermService } from '@memory/long-term/long-term.service';
import type { ActiveBookingEntry } from '@memory/long-term/long-term.types';
import { BookingSnapshotService } from '@tools/booking/booking-snapshot.service';
import type { AgentMemorySnapshot, AgentToolCall } from '@agent/generator/generator.types';
import type {
  GuardViolation,
  GuardrailRepairMode,
  GuardrailRiskLevel,
  OutputDecision,
} from '@shared-types/guardrail.contract';
import {
  GUARDRAIL_DECISION,
  GUARDRAIL_FEEDBACK_POLICY,
  GUARDRAIL_PRIORITY,
  GUARDRAIL_REPAIR_MODE,
  GUARDRAIL_RISK_LEVEL,
} from '@shared-types/guardrail.contract';
import { HardRulesService, type HardRuleOverrideHit } from './rules/hard-rules.service';
import { formatJobFactProvenanceTexts } from './rules/job-fact-reconciliation.rule';
import type { RuleContradiction } from './output-rule.types';
import { OutboundReplySanitizer } from './sanitizer/outbound-reply-sanitizer';

const RECENT_USER_TEXTS_LIMIT = 8;

/**
 * 出站守卫只运行可由格式、目录或工具回执确定性对账的规则。
 * 复杂对话理解由主 Agent 完成；本服务不调用第二个模型、不运行 shadow reviewer。
 */
@Injectable()
export class OutputGuardrailService {
  private readonly logger = new Logger(OutputGuardrailService.name);

  constructor(
    private readonly systemConfig: SystemConfigService,
    private readonly ruleGuard: HardRulesService,
    private readonly shortTerm: MessageWindowService,
    private readonly longTerm?: LongTermService,
    private readonly sessionFacts?: SessionFactsService,
    @Optional() private readonly bookingSnapshot?: BookingSnapshotService,
  ) {}

  private async readRecentTexts(
    chatId: string | undefined,
  ): Promise<{ assistantTexts: string[]; userTexts: string[]; messages: unknown[] }> {
    if (!chatId) return { assistantTexts: [], userTexts: [], messages: [] };
    try {
      const messages = await this.shortTerm.getMessages(chatId);
      return {
        assistantTexts: messages
          .filter((message) => message.role === 'assistant' && message.content.trim().length > 0)
          .map((message) => message.content),
        userTexts: messages
          .filter((message) => message.role === 'user' && message.content.trim().length > 0)
          .map((message) => message.content)
          .slice(-RECENT_USER_TEXTS_LIMIT),
        messages,
      };
    } catch (error: unknown) {
      this.logger.warn(
        `[OutputGuardrail] 读取会话历史失败，按无历史继续确定性审查: ${toErrorMessage(error)}`,
      );
      return { assistantTexts: [], userTexts: [], messages: [] };
    }
  }

  /**
   * 候选人名下是否有在途工单。读不到（无会话身份 / 长期记忆不可用 / 读失败）返回 undefined，
   * 让 booking 完成态哨兵保持 observe 档，不因基础设施抖动误拦。
   */
  private async readActiveBookings(
    corpId: string | undefined,
    userId: string | undefined,
  ): Promise<readonly ActiveBookingEntry[] | undefined> {
    if (!corpId || !userId) return undefined;
    // 本轮预约快照（prepare 按手机号从海绵查得、按候选人身份镜像 5 分钟）是权威读视图：
    // 候选人在聊 Y 岗时，按快照里有没有 Y 岗的在途工单判断，不再只看 active_booking 指针。
    // 指针仍并入：它带着"另一账号刚建单"的并发窗口；两者按工单号去重。
    const [snapshot, pointer] = await Promise.all([
      this.readSnapshotBookings(corpId, userId),
      this.readPointerBookings(corpId, userId),
    ]);
    if (snapshot === undefined && pointer === undefined) return undefined;
    const merged = new Map<number, ActiveBookingEntry>();
    for (const entry of [...(snapshot ?? []), ...(pointer ?? [])]) {
      if (!merged.has(entry.work_order_id)) merged.set(entry.work_order_id, entry);
    }
    return Array.from(merged.values());
  }

  private async readSnapshotBookings(
    corpId: string,
    userId: string,
  ): Promise<readonly ActiveBookingEntry[] | undefined> {
    if (!this.bookingSnapshot) return undefined;
    try {
      const record = await this.bookingSnapshot.peekForCandidate(corpId, userId);
      if (!record) return undefined;
      return record.entries.map((entry) => ({
        work_order_id: entry.workOrderId,
        linked_at: new Date(record.fetchedAt).toISOString(),
        job_id: entry.jobId,
        interview_time: entry.interviewTime ? `${entry.interviewTime}:00` : null,
      }));
    } catch (error: unknown) {
      this.logger.warn(`[OutputGuardrail] 读取预约快照失败，按未知处理: ${toErrorMessage(error)}`);
      return undefined;
    }
  }

  private async readPointerBookings(
    corpId: string,
    userId: string,
  ): Promise<readonly ActiveBookingEntry[] | undefined> {
    if (!this.longTerm) return undefined;
    try {
      const bookings = await this.longTerm.tryGetActiveBookings(corpId, userId);
      return bookings ?? undefined;
    } catch (error: unknown) {
      this.logger.warn(`[OutputGuardrail] 读取在途工单失败，按未知处理: ${toErrorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * 会话记忆里的岗位摘要（已展示岗位 / 上轮候选池 / 焦点岗位）压成出处文本，供
   * job_fact_without_provenance 对账：它们是上一轮真实工具结果沉淀后渲染进 [会话记忆] 的
   * 班次/薪资/距离，模型据此回答追问不是编造。读不到（无会话身份 / 读失败）返回空数组，
   * 规则退回只按历史回复对账。
   */
  private async readSessionJobFactTexts(
    corpId: string | undefined,
    userId: string | undefined,
    sessionId: string | undefined,
  ): Promise<string[]> {
    if (!this.sessionFacts || !corpId || !userId || !sessionId) return [];
    try {
      const state = await this.sessionFacts.getSessionState(corpId, userId, sessionId);
      return formatJobFactProvenanceTexts([
        ...(state.presentedJobs ?? []),
        ...(state.lastCandidatePool ?? []),
        state.currentFocusJob,
      ]);
    } catch (error: unknown) {
      this.logger.warn(
        `[OutputGuardrail] 读取会话岗位记忆失败，按无记忆出处继续对账: ${toErrorMessage(error)}`,
      );
      return [];
    }
  }

  async check(input: OutputGuardInput): Promise<OutputGuardDecision> {
    const reply = input.reply?.trim() ?? '';
    if (!reply) return this.passDecision([], []);

    const [recent, runtimeConfig, activeBookings, sessionJobFactTexts] = await Promise.all([
      this.readRecentTexts(input.chatId),
      this.systemConfig.getAgentReplyConfig(),
      this.readActiveBookings(input.corpId, input.userId),
      this.readSessionJobFactTexts(input.corpId, input.userId, input.sessionId),
    ]);
    const pruned = OutboundReplySanitizer.pruneRepeatedSegments(
      reply,
      recent.assistantTexts,
      input.userMessage,
    );
    const deterministicReply = pruned.text !== reply ? pruned.text : undefined;
    const ruleResult = this.ruleGuard.check({
      replyText: pruned.text,
      toolCalls: input.toolCalls,
      chatId: input.chatId,
      userId: input.userId,
      traceId: input.traceId,
      contactName: input.contactName,
      botImId: input.botImId,
      botUserName: input.botUserName,
      userMessage: input.userMessage,
      recentUserTexts: recent.userTexts,
      recentMessages: recent.messages,
      memorySnapshot: input.memorySnapshot,
      priorAssistantTexts: recent.assistantTexts,
      sessionJobFactTexts,
      activeBookings,
      silent: input.silent,
      hardRuleOverrides: runtimeConfig.hardRuleOverrides ?? {},
    });
    const contradictions = ruleResult.contradictions;
    const ruleIds = contradictions.map((rule) => rule.ruleId);
    const blockedRuleIds = contradictions
      .filter((rule) => rule.currentReplySendable === false)
      .map((rule) => rule.ruleId);
    const decision = this.mergeRuleDecision(contradictions);
    const overrideMarkers = this.buildHardRuleOverrideMarkers(ruleResult.overrideHits);

    let output: OutputGuardDecision;
    if (decision === GUARDRAIL_DECISION.REPLAN || decision === GUARDRAIL_DECISION.REPAIR) {
      const actionable = contradictions.filter((rule) => rule.currentReplySendable === false);
      output = {
        decision,
        riskLevel: this.resolveRuleRiskLevel(actionable),
        violations: actionable.map((rule) => this.ruleToViolation(rule)),
        ruleIds,
        blockedRuleIds,
        // 任一不可发送命中声明 replan，本轮修复即为同参重生成：首版整体作废，局部重写没有意义。
        repairMode: actionable.some((rule) => rule.repairMode === GUARDRAIL_REPAIR_MODE.REPLAN)
          ? GUARDRAIL_REPAIR_MODE.REPLAN
          : GUARDRAIL_REPAIR_MODE.REWRITE,
        repairToolNames: [],
        feedbackToGenerator: this.buildFeedbackToGenerator(actionable) || undefined,
      };
    } else {
      output = this.passDecision(ruleIds, blockedRuleIds);
    }

    return {
      ...output,
      ...(deterministicReply === undefined ? {} : { deterministicReply }),
      ...(overrideMarkers.length === 0 ? {} : { overrideMarkers }),
    };
  }

  private passDecision(ruleIds: string[], blockedRuleIds: string[]): OutputGuardDecision {
    return {
      decision: GUARDRAIL_DECISION.PASS,
      riskLevel: GUARDRAIL_RISK_LEVEL.LOW,
      violations: [],
      ruleIds,
      blockedRuleIds,
      repairMode: GUARDRAIL_REPAIR_MODE.REWRITE,
    };
  }

  private mergeRuleDecision(contradictions: RuleContradiction[]): OutputDecision {
    const actions = contradictions.map((rule) => rule.action);
    if (actions.includes('replan')) return GUARDRAIL_DECISION.REPLAN;
    if (actions.includes('repair')) return GUARDRAIL_DECISION.REPAIR;
    if (actions.includes('observe')) return GUARDRAIL_DECISION.OBSERVE;
    return GUARDRAIL_DECISION.PASS;
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
      allowFailOpen: rule.allowFailOpen,
      currentReplySendable: rule.currentReplySendable,
      feedbackPolicy: rule.feedbackPolicy,
      repairMode: rule.repairMode,
    };
  }

  private buildFeedbackToGenerator(rules: RuleContradiction[]): string {
    return rules
      .map((rule) => rule.feedbackToGenerator?.trim())
      .filter((line): line is string => Boolean(line))
      .join('\n');
  }

  private buildHardRuleOverrideMarkers(hits: HardRuleOverrideHit[] | undefined): string[] {
    return Array.from(new Set((hits ?? []).map((hit) => `override:${hit.mode}:${hit.ruleId}`)));
  }
}

export interface OutputGuardInput {
  reply: string;
  toolCalls: AgentToolCall[];
  turnLedger?: import('@shared-types/turn.types').TurnLedger;
  memorySnapshot?: AgentMemorySnapshot;
  redLines?: string[];
  userMessage?: string;
  chatId?: string;
  userId?: string;
  /** 与 userId 一起定位长期记忆（在途工单对账）；缺省时不查。 */
  corpId?: string;
  /** 与 corpId/userId 一起定位会话记忆（岗位摘要出处对账）；缺省时不读。 */
  sessionId?: string;
  traceId?: string;
  contactName?: string;
  botImId?: string;
  botUserName?: string;
  silent?: boolean;
}

export interface OutputGuardDecision {
  decision: OutputDecision;
  riskLevel: GuardrailRiskLevel;
  violations: GuardViolation[];
  ruleIds: string[];
  blockedRuleIds: string[];
  repairMode: GuardrailRepairMode;
  repairToolNames?: string[];
  feedbackToGenerator?: string;
  reasonCode?: string;
  overrideMarkers?: string[];
  deterministicReply?: string;
}

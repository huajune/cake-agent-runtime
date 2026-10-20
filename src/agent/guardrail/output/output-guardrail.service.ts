import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { SessionFactsService } from '@memory/short-term/facts.service';
import { MessageWindowService } from '@memory/short-term/message-window.service';
import { LongTermService } from '@memory/long-term/long-term.service';
import type { ActiveBookingEntry } from '@memory/long-term/long-term.types';
import { type ShortTermMessage, unwrapSessionFacts } from '@memory/short-term/short-term.types';
import { isHumanAgentTextMessage } from '@biz/message/utils/message-provenance.util';
import type { RecommendedJobSummary } from '@resolution/job/types';
import type { TurnFactsSnapshot, TurnLedger } from '@shared-types/turn.types';
import { resolveActiveLaborFormValue, selectVisibleSessionJobs } from '@resolution/labor-form';
import { projectTurnHints } from '@resolution/turn-hints/reducer';
import { BookingSnapshotService } from '@tools/booking/booking-snapshot.service';
import { CollectionFormService } from '@tools/collection/collection-form.service';
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
import {
  buildStudentAcceptanceEvidence,
  type StudentAcceptanceEvidence,
} from './rules/student-acceptance.rule';
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
    @Optional() private readonly collectionForms?: CollectionFormService,
  ) {}

  /**
   * 会话历史文本。assistantTexts 是全部经理侧文本（供精确重复去重）；岗位事实出处再按来源拆成
   * Agent 自己的回复与真人招聘经理手动消息——后者里的薪资数字不能为 Agent 报的薪资作证。
   */
  private async readRecentTexts(chatId: string | undefined): Promise<RecentTexts> {
    const empty: RecentTexts = {
      assistantTexts: [],
      agentAssistantTexts: [],
      humanRecruiterTexts: [],
      userTexts: [],
      messages: [],
    };
    if (!chatId) return empty;
    try {
      const messages = await this.shortTerm.getMessages(chatId);
      const assistantMessages = messages.filter(
        (message) => message.role === 'assistant' && message.content.trim().length > 0,
      );
      const isHuman = (message: ShortTermMessage) => isHumanAgentTextMessage(message);
      return {
        assistantTexts: assistantMessages.map((message) => message.content),
        agentAssistantTexts: assistantMessages
          .filter((message) => !isHuman(message))
          .map((message) => message.content),
        humanRecruiterTexts: assistantMessages.filter(isHuman).map((message) => message.content),
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
      return empty;
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
      // 本人校验未通过的条目（同号代报同行人）不算候选人本人的在途工单，否则「已约上」哨兵会按别人的单放行。
      return record.entries
        .filter((entry) => entry.ownedByCandidate !== false)
        .map((entry) => ({
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
   * 会话岗位记忆的两路对账证据（一次读取）：
   * - jobs：已展示岗位 / 上轮候选池 / 焦点岗位。压成出处文本供 job_fact_without_provenance 对账——
   *   它们是上一轮真实工具结果沉淀后渲染进 [会话记忆] 的班次/薪资/距离，模型据此回答追问不是编造；
   *   岗位本体另供按岗位绑定回复；
   * - studentAcceptance：学生身份（会话事实 + 本轮线索）与已展示/焦点岗位的社会身份档位，
   *   供 student_acceptance_contradiction 对账。岗位先过与 Prompt 同一道用工形式可见性门
   *   （selectVisibleSessionJobs）：意向切到兼职后被隐藏的全职岗，不能拿来判"学生也可以"指的是它。
   * 读不到（无会话身份 / 读失败）时岗位为空、学生证据缺省，相关规则各自退回保守口径。
   */
  private async readSessionJobEvidence(
    corpId: string | undefined,
    userId: string | undefined,
    sessionId: string | undefined,
    turnFacts: Pick<TurnFactsSnapshot, 'turnHints' | 'laborFormIntent'> | undefined,
  ): Promise<{ jobs: RecommendedJobSummary[]; studentAcceptance?: StudentAcceptanceEvidence }> {
    if (!this.sessionFacts || !corpId || !userId || !sessionId) return { jobs: [] };
    try {
      const state = await this.sessionFacts.getSessionState(corpId, userId, sessionId);
      const turnHints = turnFacts?.turnHints ?? null;
      const laborFormIntent = turnFacts?.laborFormIntent ?? { kind: 'ignore' };
      // 与 Prompt 组装同一口径：本轮高置信线索优先，其次会话高置信事实。
      const activeLaborForm = resolveActiveLaborFormValue(
        projectTurnHints(turnHints, { minConfidence: 'high' })?.preferences.labor_form ??
          unwrapSessionFacts(state.facts ?? null, { minConfidence: 'high' })?.preferences
            .labor_form ??
          null,
        laborFormIntent,
      );
      const visibleJobs = (jobs: readonly RecommendedJobSummary[]) =>
        selectVisibleSessionJobs(jobs, activeLaborForm, laborFormIntent);
      return {
        jobs: [
          ...(state.presentedJobs ?? []),
          ...(state.lastCandidatePool ?? []),
          ...(state.currentFocusJob ? [state.currentFocusJob] : []),
        ],
        studentAcceptance: buildStudentAcceptanceEvidence(
          {
            facts: state.facts,
            presentedJobs: visibleJobs(state.presentedJobs ?? []),
            currentFocusJob: state.currentFocusJob
              ? (visibleJobs([state.currentFocusJob])[0] ?? null)
              : null,
          },
          turnHints,
        ),
      };
    } catch (error: unknown) {
      this.logger.warn(
        `[OutputGuardrail] 读取会话岗位记忆失败，按无记忆出处继续对账: ${toErrorMessage(error)}`,
      );
      return { jobs: [] };
    }
  }

  /** 本轮查岗召回与 precheck 确权的岗位；没有回合账本（advisory/debug）时返回 undefined=未知。 */
  private readTurnJobs(ledger: TurnLedger | undefined): RecommendedJobSummary[] | undefined {
    if (!ledger) return undefined;
    const { fetchedJobs, attestedFocusJob } = ledger.jobs;
    return [...fetchedJobs, ...(attestedFocusJob ? [attestedFocusJob] : [])];
  }

  private async readAdditionalCandidateBooking(
    input: OutputGuardInput,
  ): Promise<{ jobId: number; workOrderId?: number } | undefined> {
    const latestPrecheck = [...input.toolCalls]
      .reverse()
      .find((call) => call.toolName === 'duliday_interview_precheck');
    const args = latestPrecheck?.args as { jobId?: number } | undefined;
    const jobId = args?.jobId ?? input.memorySnapshot?.currentFocusJob?.jobId;
    if (!this.collectionForms || !input.corpId || !input.userId || !input.botUserName || !jobId) {
      return undefined;
    }
    try {
      const form = await this.collectionForms.peekActive({
        corpId: input.corpId,
        userId: input.userId,
        botUserId: input.botUserName,
        jobId,
      });
      return form?.candidateScope === 'additional'
        ? { jobId, workOrderId: form.workOrderId }
        : undefined;
    } catch (error) {
      this.logger.warn(`读取追加候选人表单失败，按未知处理: ${toErrorMessage(error)}`);
      return undefined;
    }
  }

  async check(input: OutputGuardInput): Promise<OutputGuardDecision> {
    const reply = input.reply?.trim() ?? '';
    if (!reply) return this.passDecision([], []);

    const [recent, runtimeConfig, activeBookings, sessionJobEvidence, additionalCandidateBooking] =
      await Promise.all([
        this.readRecentTexts(input.chatId),
        this.systemConfig.getAgentReplyConfig(),
        this.readActiveBookings(input.corpId, input.userId),
        this.readSessionJobEvidence(
          input.corpId,
          input.userId,
          input.sessionId,
          input.turnLedger?.facts,
        ),
        this.readAdditionalCandidateBooking(input),
      ]);
    const sessionJobs = sessionJobEvidence.jobs;
    const sessionJobFactTexts = formatJobFactProvenanceTexts(sessionJobs);
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
      priorAssistantTexts: recent.agentAssistantTexts,
      humanRecruiterTexts: recent.humanRecruiterTexts,
      sessionJobFactTexts,
      sessionJobs,
      turnJobs: this.readTurnJobs(input.turnLedger),
      studentAcceptance: sessionJobEvidence.studentAcceptance,
      activeBookings,
      pendingAdditionalCandidateJobId:
        additionalCandidateBooking?.workOrderId === undefined
          ? additionalCandidateBooking?.jobId
          : undefined,
      submittedAdditionalCandidateBooking:
        additionalCandidateBooking?.workOrderId !== undefined
          ? additionalCandidateBooking
          : undefined,
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

interface RecentTexts {
  /** 全部经理侧文本（Agent + 真人），供精确重复去重。 */
  assistantTexts: string[];
  /** Agent 自己发出的回复，供岗位事实出处对账。 */
  agentAssistantTexts: string[];
  /** 真人招聘经理手动消息（isHumanAgentTextMessage）。 */
  humanRecruiterTexts: string[];
  userTexts: string[];
  messages: unknown[];
}

export interface OutputGuardInput {
  reply: string;
  toolCalls: AgentToolCall[];
  turnLedger?: TurnLedger;
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

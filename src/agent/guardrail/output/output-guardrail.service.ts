import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger } from '@nestjs/common';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { MessageWindowService } from '@memory/short-term/message-window.service';
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
import { HardRulesService, type HardRuleOverrideHit } from './hard-rules.service';
import type { RuleContradiction } from './output-rule.types';
import { OutboundReplySanitizer } from './outbound-reply-sanitizer';

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

  async check(input: OutputGuardInput): Promise<OutputGuardDecision> {
    const reply = input.reply?.trim() ?? '';
    if (!reply) return this.passDecision([], []);

    const recent = await this.readRecentTexts(input.chatId);
    const runtimeConfig = await this.systemConfig.getAgentReplyConfig();
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
    if (decision === GUARDRAIL_DECISION.BLOCK || decision === GUARDRAIL_DECISION.REVISE) {
      const actionable = contradictions.filter((rule) => rule.currentReplySendable === false);
      output = {
        decision,
        riskLevel:
          decision === GUARDRAIL_DECISION.BLOCK
            ? GUARDRAIL_RISK_LEVEL.HIGH
            : this.resolveRuleRiskLevel(actionable),
        violations: actionable.map((rule) => this.ruleToViolation(rule)),
        ruleIds,
        blockedRuleIds,
        repairMode: GUARDRAIL_REPAIR_MODE.REWRITE,
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
    if (actions.includes('block')) return GUARDRAIL_DECISION.BLOCK;
    if (actions.includes('revise')) return GUARDRAIL_DECISION.REVISE;
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
      recoverability: rule.recoverability,
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

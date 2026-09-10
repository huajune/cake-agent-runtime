import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger } from '@nestjs/common';
import { AlertLevel } from '@enums/alert.enum';
import type { AgentMemorySnapshot, AgentToolCall } from '@agent/generator/generator.types';
import type { ActiveBookingEntry } from '@memory/long-term/long-term.types';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import type {
  HardRuleOverrideMode,
  HardRuleOverrides,
} from '@biz/hosting-config/types/hosting-config.types';
import { GUARDRAIL_ACTION, GUARDRAIL_PRIORITY } from '@shared-types/guardrail.contract';
import {
  detectBrandAliasFuzzyMatchIgnored,
  detectRequestedBrandMismatch,
} from './brand-name-errors.rule';
import { DISCRIMINATION_LEAK_RULES } from './discrimination-leaks.rule';
import { FALSE_PROMISE_RULES } from './false-promises.rule';
import {
  detectBookingDoneClaimWithoutSubmission,
  detectCancelDoneClaimWithoutSubmission,
} from './booking-claim-reconciliation.rule';
import {
  detectJobFactWithoutProvenance,
  detectJobQueryClaimWithoutQuery,
} from './job-fact-reconciliation.rule';
import { detectExperienceFraudCoaching } from './experience-fraud-coaching.rule';
import { detectIdentityMisregistrationCoaching } from './identity-fraud-coaching.rule';
import { detectInvalidModelOutput } from './invalid-model-output.rule';
import { detectOnlineInterviewLocationClaim } from './online-interview-location.rule';
import { detectInterviewSlotAvailabilityMismatch } from './interview-slot-availability.rule';
import { detectProactiveInsurancePolicyMention } from './insurance-policy-claims.rule';
import {
  detectHumanServicePhraseLeak,
  detectMetaNarrationReply,
  detectInternalOutputLeak,
} from './internal-info-leaks.rule';
import { detectBookingReceiptMismatch } from './booking-receipt.rule';
import { detectSettlementCycleMismatch } from './settlement-cycle-mismatch.rule';
import { detectUnsupportedStoreStatusSpeculation } from './store-status-speculation.rule';
import { deriveRulePolicy, type FactRule, type RuleContradiction } from '../output-rule.types';
import { createOutputRuleFinding, isOutputRuleId, type OutputRuleId } from '../output-rule-catalog';

export type { GuardrailRuleAction } from '../output-rule.types';
export {
  OUTPUT_RULE_CATALOG,
  OUTPUT_RULE_IDS,
  type OutputRuleCatalogMetadata,
} from '../output-rule-catalog';

export interface HardRuleOverrideHit {
  ruleId: OutputRuleId;
  mode: HardRuleOverrideMode;
}

/**
 * Reply 后置确定性对账：只检查封闭高风险形态、格式泄漏和结构化工具回执冲突。
 * 命中结果交由 OutputGuardrailService 聚合，再由 runner 决定静默、重写或同参重生成；
 * 既有运行时 override 仍可把规则临时降为 observe 或关闭。catalog 还登记少量 observe 哨兵：只记录不拦截，
 * 供 badcase 发现与升档判例累计。
 *
 * 规则维护：确定性规则按领域拆在 `output/rules/*.rule.ts`，本 service 只负责调度和告警。
 */
@Injectable()
export class HardRulesService {
  private readonly logger = new Logger(HardRulesService.name);

  /**
   * 纯文本 + 简单工具存在性即可判断的规则集合。
   *
   * 这里刻意只放 FactRule：
   * - false-promises 里的“名额承诺”（该族现仅剩 quota_promise）；
   * - discrimination-leaks 里的“敏感筛选条件外露”。
   *
   * 如果规则需要读取 tool.result 里的结构化字段，或需要生成动态 label，
   * 就不要塞进这个数组，而应写成 detectXxx 函数并在 check() 里显式编排。
   */
  private readonly rules: FactRule[] = [...FALSE_PROMISE_RULES, ...DISCRIMINATION_LEAK_RULES];

  /** 同一脏 ruleId 每进程只告警一次，避免运行时配置在热路径持续刷屏。 */
  private readonly warnedUnknownOverrideRuleIds = new Set<string>();

  constructor(private readonly alertNotifier: AlertNotifierService) {}

  /**
   * 检查 reply 是否与本轮 tool 调用矛盾。
   *
   * - observe：观察规则或 runtime override，内容仍可发送并保留审计结果
   * - repair：当前草稿不可发送，由 Runner 选择机械清理或无工具修复
   * - replan：当前草稿不可发送，按同参数重进 Generator；独立策略保留 fail-open 约束
   *
   * @returns 命中的规则与是否需要出站短路；调用方可记 anomaly_flag
   */
  check(params: {
    replyText: string;
    toolCalls: AgentToolCall[] | undefined;
    chatId?: string;
    userId?: string;
    traceId?: string;
    contactName?: string;
    botImId?: string;
    botUserName?: string;
    /** 本轮候选人输入，用于写 badcase 时构建对话上下文 */
    userMessage?: string;
    /** 最近几条候选人消息（时间序，含本轮），供跨轮豁免（如上轮问社保、本轮作答）。 */
    recentUserTexts?: string[];
    /** 最近会话消息（保留 role 与顺序），供身份二选一问答等上下文证据识别。 */
    recentMessages?: unknown[];
    /** 本轮入口记忆事实，用于跨轮身份红线对账。 */
    memorySnapshot?: AgentMemorySnapshot;
    /** 会话内历史助手回复（不含本轮），供“无来源岗位事实”对账。 */
    priorAssistantTexts?: readonly string[];
    /**
     * 候选人名下在途工单（长期记忆 active_booking）。undefined=未知（只落 observe），
     * []=确证没有任何工单——完成时态的“已帮你约好”此时是假回执，升 repair；有工单但都不是
     * 本轮焦点岗位时同样升 repair。
     */
    activeBookings?: readonly ActiveBookingEntry[];
    /** 静默模式（advisory）：只返回裁决，由调用方避免写生产守卫日志。 */
    silent?: boolean;
    /** 兼容既有托管配置的运行时降档；只允许 off/observe。 */
    hardRuleOverrides?: HardRuleOverrides;
  }): {
    hit: boolean;
    contradictions: RuleContradiction[];
    /** 仅 override 真正作用到命中时返回；off 命中即使被丢弃也保留此审计信号。 */
    overrideHits?: HardRuleOverrideHit[];
  } {
    const text = params.replyText ?? '';
    if (!text.trim()) return { hit: false, contradictions: [] };

    const toolCalls = params.toolCalls ?? [];
    const contradictions: RuleContradiction[] = [];

    /**
     * 运行顺序说明：
     * 1. 先跑“发出去不可恢复/高确定性”的规则：内部信息泄漏、诚信红线；
     * 2. 再跑通用 FactRule 列表；
     * 3. 最后跑工具回执对账规则。
     *
     * 顺序不用于短路：同一条 reply 可能同时命中多条规则，全部收集后统一告警。
     * OutputGuardrail 汇总草稿处理意见，Runner 决定最终投递、静默或人工介入。
     *
     * 岗位、预约和位置事实的宽泛语义判定由主 Agent 的对话理解承担，不得重新堆回规则。
     * 这里只保留可由结构化工具结果稳定公证的窄契约。
     */

    // 必须在 sanitizer 删除 <think> 标签之前识别模型/Provider 异常，避免畸形推理文本
    // 被清洗成一串看似普通、实则无语义的字符后穿透出站链路。
    const invalidModelOutput = detectInvalidModelOutput(text);
    if (invalidModelOutput) {
      contradictions.push(invalidModelOutput);
    }

    const internalOutputLeak = detectInternalOutputLeak(text);
    if (internalOutputLeak) {
      contradictions.push(internalOutputLeak);
    }

    // 元叙述旁白与阶段/工具名泄漏同族（内部视角文本外发），但形态是自然语言，
    // 词库 PATTERNS 覆盖不到，须单独形态检测；命中后 runner 直达静默不进 repair。
    const metaNarrationReply = detectMetaNarrationReply(text);
    if (metaNarrationReply) {
      contradictions.push(metaNarrationReply);
    }

    const identityMisregistrationCoaching = detectIdentityMisregistrationCoaching(
      text,
      toolCalls,
      params.memorySnapshot,
      params.userMessage,
      params.recentMessages,
      params.recentUserTexts,
    );
    if (identityMisregistrationCoaching) {
      contradictions.push(identityMisregistrationCoaching);
    }

    // 经历轴诚信红线：仅在候选人自曝造假后触发，与身份轴规则同族分治。
    const experienceFraudCoaching = detectExperienceFraudCoaching(
      text,
      params.userMessage,
      params.recentUserTexts,
    );
    if (experienceFraudCoaching) {
      contradictions.push(experienceFraudCoaching);
    }

    // booking 成功后的回执对账：不可逆副作用与回复中的日期、状态必须一致。
    const bookingReceiptMismatch = detectBookingReceiptMismatch(
      text,
      toolCalls,
      params.userMessage,
    );
    if (bookingReceiptMismatch) {
      contradictions.push(bookingReceiptMismatch);
    }

    // 线上/AI/视频/电话面试却给到店指引——候选人会白跑一趟门店。
    const onlineInterviewLocationClaim = detectOnlineInterviewLocationClaim(text, toolCalls);
    if (onlineInterviewLocationClaim) {
      contradictions.push(onlineInterviewLocationClaim);
    }

    // precheck 的 bookableSlots 已按完整日期时间裁决，生成模型只能渲染，不得二次算错。
    const interviewSlotAvailabilityMismatch = detectInterviewSlotAvailabilityMismatch(
      text,
      toolCalls,
    );
    if (interviewSlotAvailabilityMismatch) {
      contradictions.push(interviewSlotAvailabilityMismatch);
    }

    const unsupportedStoreStatusSpeculation = detectUnsupportedStoreStatusSpeculation(
      text,
      toolCalls,
    );
    if (unsupportedStoreStatusSpeculation) {
      contradictions.push(unsupportedStoreStatusSpeculation);
    }

    for (const rule of this.rules) {
      if (!rule.keywords.test(text)) continue;
      if (rule.ignorePredicate?.(text, toolCalls)) continue;
      if (rule.requiredToolPredicate(toolCalls)) continue;
      contradictions.push(createOutputRuleFinding(rule.ruleId, rule.label));
    }

    const brandAliasFuzzyMatchIgnored = detectBrandAliasFuzzyMatchIgnored(text, toolCalls);
    if (brandAliasFuzzyMatchIgnored) {
      contradictions.push(brandAliasFuzzyMatchIgnored);
    }

    // 人设露馅是封闭词表 REPAIR：prompt 红线在产仍有说漏嘴真阳（抽样），出站兜底。
    const humanServicePhraseLeak = detectHumanServicePhraseLeak(text);
    if (humanServicePhraseLeak) {
      contradictions.push(humanServicePhraseLeak);
    }

    // 以下为 observe 哨兵：只落档不改变出站裁决。
    const settlementCycleMismatch = detectSettlementCycleMismatch(
      text,
      toolCalls,
      params.memorySnapshot?.currentFocusJob?.jobId,
    );
    if (settlementCycleMismatch) {
      contradictions.push(settlementCycleMismatch);
    }

    const requestedBrandMismatch = detectRequestedBrandMismatch(text, toolCalls);
    if (requestedBrandMismatch) {
      contradictions.push(requestedBrandMismatch);
    }

    const proactiveInsuranceMention = detectProactiveInsurancePolicyMention(
      text,
      params.userMessage,
      params.recentUserTexts,
    );
    if (proactiveInsuranceMention) {
      contradictions.push(proactiveInsuranceMention);
    }

    const bookingDoneClaimWithoutSubmission = detectBookingDoneClaimWithoutSubmission(
      text,
      toolCalls,
      {
        activeBookings: params.activeBookings,
        focusJobId: params.memorySnapshot?.currentFocusJob?.jobId,
      },
    );
    if (bookingDoneClaimWithoutSubmission) {
      contradictions.push(bookingDoneClaimWithoutSubmission);
    }

    const cancelDoneClaim = detectCancelDoneClaimWithoutSubmission(text, toolCalls);
    if (cancelDoneClaim) {
      contradictions.push(cancelDoneClaim);
    }

    // 零工具轮的岗位事实对账：宣称查过 / 报出无来源数字，两条各取高置信形态。
    const jobQueryClaim = detectJobQueryClaimWithoutQuery(text, toolCalls);
    if (jobQueryClaim) {
      contradictions.push(jobQueryClaim);
    }
    // 出处对账依赖会话历史：调用方没带 chatId（advisory 流、debug）时读不到历史，
    // "无法判出处"不等于"无出处"，跳过而不是误拦。
    const jobFactWithoutProvenance = params.chatId
      ? detectJobFactWithoutProvenance(text, toolCalls, [
          ...(params.priorAssistantTexts ?? []),
          ...(params.recentUserTexts ?? []),
          ...(params.userMessage ? [params.userMessage] : []),
        ])
      : null;
    if (jobFactWithoutProvenance) {
      contradictions.push(jobFactWithoutProvenance);
    }

    const { effectiveContradictions, overrideHits } = this.applyHardRuleOverrides(
      contradictions,
      params.hardRuleOverrides,
    );
    if (effectiveContradictions.length === 0) {
      return overrideHits.length > 0
        ? { hit: false, contradictions: [], overrideHits }
        : { hit: false, contradictions: [] };
    }

    const hasNonSendable = effectiveContradictions.some((c) => c.currentReplySendable === false);
    const hasRepair = effectiveContradictions.some((c) => c.action === GUARDRAIL_ACTION.REPAIR);
    const actionLabel = hasNonSendable ? 'veto_current_reply' : hasRepair ? 'repair' : 'warn';

    this.logger.warn(
      `[ReplyFactGuard] 命中事实矛盾: chatId=${params.chatId ?? '-'}, userId=${params.userId ?? '-'}, action=${
        actionLabel
      }, rules=${effectiveContradictions
        .map((c) => c.ruleId)
        .join(',')}, replyPreview="${text.slice(0, 80)}"${params.silent ? ' [silent]' : ''}`,
    );

    // silent（advisory 调试流量）：只返回裁决，runner 不写生产守卫日志。
    if (params.silent) {
      return overrideHits.length > 0
        ? { hit: true, contradictions: effectiveContradictions, overrideHits }
        : { hit: true, contradictions: effectiveContradictions };
    }

    const p0Contradictions = effectiveContradictions.filter(
      (contradiction) =>
        contradiction.severity === GUARDRAIL_PRIORITY.P0 &&
        contradiction.currentReplySendable === false,
    );
    if (p0Contradictions.length > 0) {
      void this.alertNotifier
        .sendAlert({
          code: 'output_guardrail_p0_intercepted',
          severity: AlertLevel.ERROR,
          summary: '出站守卫拦截 P0 回复事故',
          source: {
            subsystem: 'agent',
            component: 'output-guardrail',
            action: 'intercept_p0_reply',
          },
          scope: {
            messageId: params.traceId,
            chatId: params.chatId,
            userId: params.userId,
            contactName: params.contactName,
          },
          impact: {
            userVisible: false,
            requiresHumanIntervention: false,
          },
          diagnostics: {
            category: 'p0_guardrail_interception',
            payload: {
              ruleIds: p0Contradictions.map((contradiction) => contradiction.ruleId),
              currentReplySendable: false,
            },
          },
          dedupe: {
            key: `output_guardrail_p0_intercepted:${p0Contradictions
              .map((contradiction) => contradiction.ruleId)
              .sort()
              .join(',')}`,
          },
        })
        .catch((error: unknown) => {
          this.logger.warn(`[ReplyFactGuard] P0 告警发送失败: ${toErrorMessage(error)}`);
        });
    }

    // 所有 rule 命中与修复过程由 runner 统一归档到 guardrail_review_records。
    // 机器判例不自动创建 BadCase；BadCase 只接收人工确认需要修复的问题。
    return overrideHits.length > 0
      ? { hit: true, contradictions: effectiveContradictions, overrideHits }
      : { hit: true, contradictions: effectiveContradictions };
  }

  /**
   * 所有规则完成评估后统一收权。未知 ruleId 不参与匹配并告警；off 命中从裁决里丢弃，
   * observe 命中重新派生 sendable policy。overrideHits 独立返回，确保 off 仍可归档取证。
   */
  private applyHardRuleOverrides(
    contradictions: RuleContradiction[],
    configuredOverrides: HardRuleOverrides | undefined,
  ): { effectiveContradictions: RuleContradiction[]; overrideHits: HardRuleOverrideHit[] } {
    if (!configuredOverrides || Object.keys(configuredOverrides).length === 0) {
      return { effectiveContradictions: contradictions, overrideHits: [] };
    }

    const overrides: HardRuleOverrides = {};
    for (const [ruleId, mode] of Object.entries(configuredOverrides)) {
      if (!isOutputRuleId(ruleId)) {
        if (!this.warnedUnknownOverrideRuleIds.has(ruleId)) {
          this.warnedUnknownOverrideRuleIds.add(ruleId);
          this.logger.warn(`[ReplyFactGuard] 忽略未知 hardRuleOverrides ruleId: ${ruleId}`);
        }
        continue;
      }
      if (mode === 'off' || mode === 'observe') overrides[ruleId] = mode;
    }

    const overrideHitsByKey = new Map<string, HardRuleOverrideHit>();
    const effectiveContradictions = contradictions.flatMap((contradiction) => {
      const mode = overrides[contradiction.ruleId];
      if (!mode) return [contradiction];

      const hit = { ruleId: contradiction.ruleId, mode };
      overrideHitsByKey.set(`${mode}:${contradiction.ruleId}`, hit);
      if (mode === 'off') return [];

      return [
        {
          ...contradiction,
          action: GUARDRAIL_ACTION.OBSERVE,
          ...deriveRulePolicy(GUARDRAIL_ACTION.OBSERVE),
          allowFailOpen: true,
        },
      ];
    });

    return {
      effectiveContradictions,
      overrideHits: Array.from(overrideHitsByKey.values()),
    };
  }
}

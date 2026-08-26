import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger } from '@nestjs/common';
import { AlertLevel } from '@enums/alert.enum';
import type { AgentMemorySnapshot, AgentToolCall } from '@agent/generator/generator.types';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import type {
  HardRuleOverrideMode,
  HardRuleOverrides,
} from '@biz/hosting-config/types/hosting-config.types';
import {
  GUARDRAIL_ACTION,
  GUARDRAIL_DATA_SENSITIVITY,
  GUARDRAIL_FEEDBACK_POLICY,
  GUARDRAIL_PRIORITY,
} from '@shared-types/guardrail.contract';
import {
  detectBrandAliasFuzzyMatchIgnored,
  detectRequestedBrandMismatch,
} from './rules/brand-name-errors.rule';
import { detectDanglingReplyPromise } from './rules/dangling-promise.rule';
import {
  detectBookingPromiseWithoutBooking,
  detectHandoffPromiseWithoutAction,
} from './rules/promise-reconciliation.rule';
import { DISCRIMINATION_LEAK_RULES } from './rules/discrimination-leaks.rule';
import { FALSE_PROMISE_RULES } from './rules/false-promises.rule';
import { detectDateReferenceMismatch } from './rules/date-reference-mismatch.rule';
import { detectUnsupportedApplicationRecordUpdatePromise } from './rules/application-record-update-promise.rule';
import { detectExperienceFraudCoaching } from './rules/experience-fraud-coaching.rule';
import { detectExampleValueLeak } from './rules/example-value-leak.rule';
import { detectIdentityMisregistrationCoaching } from './rules/identity-fraud-coaching.rule';
import { detectProactiveInsurancePolicyMention } from './rules/insurance-policy-claims.rule';
import { detectInvalidModelOutput } from './rules/invalid-model-output.rule';
import { detectOnlineInterviewLocationClaim } from './rules/online-interview-location.rule';
import {
  detectHumanServicePhraseLeak,
  detectMetaNarrationReply,
  detectOutputLeak,
} from './rules/internal-info-leaks.rule';
import { detectBookingReceiptMismatch } from './rules/booking-receipt.rule';
import { detectJobDetailLookupRequired } from './rules/job-detail-grounding.rule';
import { detectRepeatedReply } from './rules/repeated-reply.rule';
import { detectUnsupportedScheduleWindowClaim } from './rules/schedule-window-claims.rule';
import { detectSettlementCycleMismatch } from './rules/settlement-cycle-mismatch.rule';
import { detectUnsupportedStoreStatusSpeculation } from './rules/store-status-speculation.rule';
import { detectSummerWorkerAlternativeUpsell } from './rules/summer-worker-alternative-upsell.rule';
import {
  detectCombinationScheduleWeeklyGeneralization,
  detectHealthCertificateGeneralization,
} from './rules/ungrounded-generalizations.rule';
import { detectImageDescriptionNotSaved } from './rules/visual-message-errors.rule';
import { deriveRulePolicy, type FactRule, type RuleContradiction } from './output-rule.types';
import { OUTPUT_RULE_CATALOG, type OutputRuleCatalogMetadata } from './rules/output-rule-catalog';

export type { GuardrailRuleAction } from './output-rule.types';
export {
  OUTPUT_RULE_CATALOG,
  OUTPUT_RULE_IDS,
  type OutputRuleCatalogMetadata,
} from './rules/output-rule-catalog';

export interface HardRuleOverrideHit {
  ruleId: string;
  mode: HardRuleOverrideMode;
}

/**
 * Reply 后置事实对账。
 *
 * 设计目的：拦截 Agent 在确认轮 / 收尾轮"自由发挥"——即没有真正调任何工具
 * 却声称动态事实（群人数、库存、距离、薪资）。历史 badcase i41pab8n：
 * 上一轮 invite_to_group 已成功，本轮用户回"好的"，Agent 无 tool 调用
 * 编出"群里人数满了"。
 *
 * 规则按 catalog action 决定处理方式：observe 只告警；revise/block 当前文本不可发送，
 * 由 runner 进入一次受控重写（replan 已于 2026-07-27 从规则 action 退役）。
 * 低确定性的体验类规则仍保留 observe。
 *
 * 阻断规则（action='block'）：歧视性筛选条件外露这类"发出去即不可挽回"的内容，
 * 重写后仍需二审通过才可投递，救不活则整轮静默（meta_narration 等直达静默特例见 runner）。
 *
 * 规则维护：确定性规则按领域拆在 `output/rules/*.rule.ts`，本 service 只负责调度和告警。
 */
@Injectable()
export class HardRulesService {
  private readonly logger = new Logger(HardRulesService.name);

  /**
   * 内部实现泄漏（阶段名、工具名、JSON/代码块）属于出站内容安全问题，不应留到投递层静默吞掉。
   * 命中即 block，交由 runner/outcome 统一走“守卫拦截，不投递”分支。
   */
  private static detectInternalOutputLeak(text: string): RuleContradiction | null {
    const leakedPattern = detectOutputLeak(text);
    if (!leakedPattern) return null;
    return {
      ruleId: 'internal_output_leak',
      label: `回复疑似泄漏 Agent 内部状态/工具实现（pattern=${leakedPattern.source}），必须拦截不发送`,
      action: GUARDRAIL_ACTION.BLOCK,
    };
  }

  /**
   * 纯文本 + 简单工具存在性即可判断的规则集合。
   *
   * 这里刻意只放 FactRule：
   * - false-promises 里的“名额承诺”（2026-07-10 批量下线后仅剩 quota_promise）；
   * - discrimination-leaks 里的“敏感筛选条件外露”。
   *
   * 如果规则需要读取 tool.result 里的结构化字段，或需要生成动态 label，
   * 就不要塞进这个数组，而应写成 detectXxx 函数并在 check() 里显式编排。
   */
  private readonly rules: FactRule[] = [...FALSE_PROMISE_RULES, ...DISCRIMINATION_LEAK_RULES];

  private readonly rulePolicyById = new Map<string, OutputRuleCatalogMetadata>(
    OUTPUT_RULE_CATALOG.map((rule) => [rule.id, rule]),
  );
  /** 同一脏 ruleId 每进程只告警一次，避免运行时配置在热路径持续刷屏。 */
  private readonly warnedUnknownOverrideRuleIds = new Set<string>();

  constructor(private readonly alertNotifier: AlertNotifierService) {}

  /**
   * 检查 reply 是否与本轮 tool 调用矛盾。
   *
   * - observe 规则：命中即日志 + 落库 guardrail_review_records（不写飞书），内容仍可发送
   * - revise 规则：当前回复不可发送，由 OutputGuardrail/runner 进入受控修复
   * - block 规则：当前回复不可发送；runner 仍先尝试一次受控重写，二审仍违规才静默丢弃
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
    /** 本会话已投递的 assistant 消息（时间序），供重复输出/重复问候对账。 */
    recentAssistantTexts?: string[];
    /** 最近几条候选人消息（时间序，含本轮），供跨轮豁免（如上轮问社保、本轮作答）。 */
    recentUserTexts?: string[];
    /** 最近会话消息（保留 role 与顺序），供身份二选一问答等上下文证据识别。 */
    recentMessages?: unknown[];
    /** 本轮入口记忆事实，用于跨轮身份红线对账。 */
    memorySnapshot?: AgentMemorySnapshot;
    /** 静默模式（advisory）：只返回裁决，由调用方避免写生产守卫日志。 */
    silent?: boolean;
    /** Dashboard 运行时降档配置；只允许 off/observe。 */
    hardRuleOverrides?: HardRuleOverrides;
    /** 由组合器先行确定性识别、仍须统一经过 catalog policy/override 的命中。 */
    precomputedContradictions?: RuleContradiction[];
  }): {
    hit: boolean;
    contradictions: RuleContradiction[];
    /** 仅 override 真正作用到命中时返回；off 命中即使被丢弃也保留此审计信号。 */
    overrideHits?: HardRuleOverrideHit[];
  } {
    const text = params.replyText ?? '';
    if (!text.trim()) return { hit: false, contradictions: [] };

    const toolCalls = params.toolCalls ?? [];
    const contradictions: RuleContradiction[] = (params.precomputedContradictions ?? []).map(
      (contradiction) => this.withRulePolicy(contradiction),
    );

    /**
     * 运行顺序说明：
     * 1. 先跑“发出去不可恢复/高确定性”的规则：内部信息泄漏、诚信红线；
     * 2. 再跑通用 FactRule 列表；
     * 3. 最后跑质量/体验类补充规则：图片描述、保险、品牌、复读。
     *
     * 顺序不用于短路：同一条 reply 可能同时命中多条规则，全部收集后统一告警。
     * 只有最终 blocked=true 才由 OutputGuardrail/runner 丢弃回复。
     *
     * 2026-07-10 用户裁定批量下线（勿修补勿重加，与 settlement_cycle_mismatch 同批治理）：
     * job-fact-hallucinations（未接地推荐/薪资编造/班次过滤空推荐/暑假工降级）、
     * job-fact-value-mismatch（班次极性/时薪数值对账）、booking-claim-errors（收资字段/
     * 确认时间透传/等通知收时间与编时间/precheck 口径/handoff 无预约）、
     * location-claim-errors（geocode 不确定位置声称）整族删除；false-promises 只保留
     * quota_promise（group_full_without_invite / system_status_fabrication /
     * tool_failure_success_claim 同批下线）；brand_name_violation（平台错名+岗位品牌改写）
     * 及其 runner 确定性修复快通道同批下线。岗位/预约事实治理交语义档。
     * 2026-07-15 新 badcase 6a5729fe 表明“详情缺字段仍直接猜测”无法仅靠语义档治理，
     * 用户重新裁定启用两条更窄的确定性契约：job_detail_lookup_required 只检查是否按
     * 当前 jobId 补查；settlement_cycle_mismatch 只对账正式结算与培训/阶梯补充结算。
     */

    // 必须在 sanitizer 删除 <think> 标签之前识别模型/Provider 异常，避免畸形推理文本
    // 被清洗成一串看似普通、实则无语义的字符后穿透出站链路。
    const invalidModelOutput = detectInvalidModelOutput(text);
    if (invalidModelOutput) {
      contradictions.push(this.withRulePolicy(invalidModelOutput));
    }

    const internalOutputLeak = HardRulesService.detectInternalOutputLeak(text);
    if (internalOutputLeak) {
      contradictions.push(this.withRulePolicy(internalOutputLeak));
    }

    // 元叙述旁白与阶段/工具名泄漏同族（内部视角文本外发），但形态是自然语言，
    // 词库 PATTERNS 覆盖不到，须单独形态检测；命中后 runner 直达静默不进 repair。
    const metaNarrationReply = detectMetaNarrationReply(text);
    if (metaNarrationReply) {
      contradictions.push(this.withRulePolicy(metaNarrationReply));
    }

    const exampleValueLeak = detectExampleValueLeak(text);
    if (exampleValueLeak) {
      contradictions.push(this.withRulePolicy(exampleValueLeak));
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
      contradictions.push(this.withRulePolicy(identityMisregistrationCoaching));
    }

    // 经历轴诚信红线：仅在候选人自曝造假后触发，与身份轴规则同族分治。
    const experienceFraudCoaching = detectExperienceFraudCoaching(
      text,
      params.userMessage,
      params.recentUserTexts,
    );
    if (experienceFraudCoaching) {
      contradictions.push(this.withRulePolicy(experienceFraudCoaching));
    }

    const applicationRecordUpdatePromise = detectUnsupportedApplicationRecordUpdatePromise(
      text,
      params.userMessage,
      params.recentUserTexts,
    );
    if (applicationRecordUpdatePromise) {
      contradictions.push(this.withRulePolicy(applicationRecordUpdatePromise));
    }

    // 相对日词与括注日期对账：日历事实可确定性校验，日期错乱会让候选人错过/空等面试。
    const dateReferenceMismatch = detectDateReferenceMismatch(text, new Date(), toolCalls);
    if (dateReferenceMismatch) {
      contradictions.push(this.withRulePolicy(dateReferenceMismatch));
    }

    const summerWorkerAlternativeUpsell = detectSummerWorkerAlternativeUpsell(
      text,
      toolCalls,
      params.userMessage,
      params.recentUserTexts,
    );
    if (summerWorkerAlternativeUpsell) {
      contradictions.push(this.withRulePolicy(summerWorkerAlternativeUpsell));
    }

    const jobDetailLookupRequired = detectJobDetailLookupRequired(
      toolCalls,
      params.memorySnapshot,
      params.userMessage,
    );
    if (jobDetailLookupRequired) {
      contradictions.push(this.withRulePolicy(jobDetailLookupRequired));
    }

    const settlementCycleMismatch = detectSettlementCycleMismatch(
      text,
      toolCalls,
      params.memorySnapshot?.currentFocusJob?.jobId,
    );
    if (settlementCycleMismatch) {
      contradictions.push(this.withRulePolicy(settlementCycleMismatch));
    }

    // booking 成功后的回执对账：不可逆副作用与回复必须一致（问日期=矛盾，零播报=observe）。
    const bookingReceiptMismatch = detectBookingReceiptMismatch(
      text,
      toolCalls,
      params.userMessage,
    );
    if (bookingReceiptMismatch) {
      contradictions.push(this.withRulePolicy(bookingReceiptMismatch));
    }

    // 线上/AI/视频/电话面试却给到店指引——候选人会白跑一趟门店。
    const onlineInterviewLocationClaim = detectOnlineInterviewLocationClaim(text, toolCalls);
    if (onlineInterviewLocationClaim) {
      contradictions.push(this.withRulePolicy(onlineInterviewLocationClaim));
    }

    const unsupportedScheduleWindowClaim = detectUnsupportedScheduleWindowClaim(
      text,
      toolCalls,
      params.memorySnapshot?.currentFocusJob?.jobId,
      params.userMessage,
      params.recentUserTexts,
    );
    if (unsupportedScheduleWindowClaim) {
      contradictions.push(this.withRulePolicy(unsupportedScheduleWindowClaim));
    }

    const combinationScheduleWeeklyGeneralization = detectCombinationScheduleWeeklyGeneralization(
      text,
      toolCalls,
      params.userMessage,
    );
    if (combinationScheduleWeeklyGeneralization) {
      contradictions.push(this.withRulePolicy(combinationScheduleWeeklyGeneralization));
    }

    const healthCertificateGeneralization = detectHealthCertificateGeneralization(
      text,
      toolCalls,
      params.userMessage,
    );
    if (healthCertificateGeneralization) {
      contradictions.push(this.withRulePolicy(healthCertificateGeneralization));
    }

    const unsupportedStoreStatusSpeculation = detectUnsupportedStoreStatusSpeculation(
      text,
      toolCalls,
    );
    if (unsupportedStoreStatusSpeculation) {
      contradictions.push(this.withRulePolicy(unsupportedStoreStatusSpeculation));
    }

    for (const rule of this.rules) {
      if (!rule.keywords.test(text)) continue;
      if (rule.ignorePredicate?.(text, toolCalls)) continue;
      if (rule.requiredToolPredicate(toolCalls)) continue;
      contradictions.push(
        this.withRulePolicy({ ruleId: rule.ruleId, label: rule.label, action: rule.action }),
      );
    }

    const imageDescriptionNotSaved = detectImageDescriptionNotSaved(
      text,
      toolCalls,
      params.userMessage,
    );
    if (imageDescriptionNotSaved) {
      contradictions.push(this.withRulePolicy(imageDescriptionNotSaved));
    }

    const proactiveInsuranceMention = detectProactiveInsurancePolicyMention(
      text,
      params.userMessage,
      params.recentUserTexts,
    );
    if (proactiveInsuranceMention) {
      contradictions.push(this.withRulePolicy(proactiveInsuranceMention));
    }

    const requestedBrandMismatch = detectRequestedBrandMismatch(text, toolCalls);
    if (requestedBrandMismatch) {
      contradictions.push(this.withRulePolicy(requestedBrandMismatch));
    }

    const danglingPromise = detectDanglingReplyPromise(text, toolCalls);
    if (danglingPromise) {
      contradictions.push(this.withRulePolicy(danglingPromise));
    }

    // 承诺-动作对账：handoff 承诺的补动作由 turn-outcome
    // 按 ruleId 挂 sideEffect 执行；报名承诺无法自动补，改写为未提交的诚实口径。
    const handoffPromise = detectHandoffPromiseWithoutAction(text, toolCalls);
    if (handoffPromise) {
      contradictions.push(this.withRulePolicy(handoffPromise));
    }

    const bookingPromise = detectBookingPromiseWithoutBooking(text, toolCalls);
    if (bookingPromise) {
      contradictions.push(this.withRulePolicy(bookingPromise));
    }

    const brandAliasFuzzyMatchIgnored = detectBrandAliasFuzzyMatchIgnored(text, toolCalls);
    if (brandAliasFuzzyMatchIgnored) {
      contradictions.push(this.withRulePolicy(brandAliasFuzzyMatchIgnored));
    }

    const humanServicePhraseLeak = detectHumanServicePhraseLeak(text);
    if (humanServicePhraseLeak) {
      contradictions.push(this.withRulePolicy(humanServicePhraseLeak));
    }

    const repeatedReply = detectRepeatedReply(text, params.recentAssistantTexts);
    if (repeatedReply) {
      contradictions.push(this.withRulePolicy(repeatedReply));
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
    const hasRepair = effectiveContradictions.some(
      (c) => c.action === GUARDRAIL_ACTION.REVISE || c.action === GUARDRAIL_ACTION.BLOCK,
    );
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
      if (!this.rulePolicyById.has(ruleId)) {
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
        this.withRulePolicy({
          ...contradiction,
          action: GUARDRAIL_ACTION.OBSERVE,
        }),
      ];
    });

    return {
      effectiveContradictions,
      overrideHits: Array.from(overrideHitsByKey.values()),
    };
  }

  private withRulePolicy(contradiction: RuleContradiction): RuleContradiction {
    const action = contradiction.action;
    const derived = deriveRulePolicy(action);
    const policy = this.rulePolicyById.get(contradiction.ruleId);

    if (!policy) {
      const sendable = derived.currentReplySendable;
      return {
        ...contradiction,
        ...derived,
        severity: sendable ? GUARDRAIL_PRIORITY.P2 : GUARDRAIL_PRIORITY.P1,
        dataSensitivity: GUARDRAIL_DATA_SENSITIVITY.NONE,
        feedbackPolicy: sendable
          ? GUARDRAIL_FEEDBACK_POLICY.NONE
          : GUARDRAIL_FEEDBACK_POLICY.PLAIN_POLICY,
        feedbackToGenerator: sendable
          ? ''
          : `上一版回复命中 ${contradiction.ruleId}，当前文本不可发送。请按业务事实重写，只输出候选人可见回复。`,
        repairToolNames: [],
      };
    }

    return {
      ...contradiction,
      ...derived,
      severity: contradiction.severity ?? policy.severity,
      dataSensitivity: contradiction.dataSensitivity ?? policy.dataSensitivity,
      feedbackPolicy: contradiction.feedbackPolicy ?? policy.feedbackPolicy,
      feedbackToGenerator: contradiction.feedbackToGenerator ?? policy.feedbackToGenerator,
      repairToolNames: contradiction.repairToolNames ?? policy.repairToolNames,
    };
  }
}

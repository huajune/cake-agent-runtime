import { Injectable, Logger } from '@nestjs/common';
import type { AgentMemorySnapshot, AgentToolCall } from '@agent/generator/generator.types';
import {
  GUARDRAIL_ACTION,
  GUARDRAIL_DATA_SENSITIVITY,
  GUARDRAIL_FEEDBACK_POLICY,
  GUARDRAIL_PRIORITY,
} from '@shared-types/guardrail.contract';
import { ReplyFactGuardNotifierService } from '@notification/services/reply-fact-guard-notifier.service';
import {
  detectBrandAliasFuzzyMatchIgnored,
  detectRequestedBrandMismatch,
} from './rules/brand-name-errors.rule';
import { DISCRIMINATION_LEAK_RULES } from './rules/discrimination-leaks.rule';
import { FALSE_PROMISE_RULES } from './rules/false-promises.rule';
import { detectIdentityMisregistrationCoaching } from './rules/identity-fraud-coaching.rule';
import { detectProactiveInsurancePolicyMention } from './rules/insurance-policy-claims.rule';
import { detectInvalidModelOutput } from './rules/invalid-model-output.rule';
import { detectHumanServicePhraseLeak, detectOutputLeak } from './rules/internal-info-leaks.rule';
import { detectRepeatedReply } from './rules/repeated-reply.rule';
import { detectSummerWorkerAlternativeUpsell } from './rules/summer-worker-alternative-upsell.rule';
import { detectImageDescriptionNotSaved } from './rules/visual-message-errors.rule';
import { deriveRulePolicy, type FactRule, type RuleContradiction } from './output-rule.types';
import { OUTPUT_RULE_CATALOG, type OutputRuleCatalogMetadata } from './rules/output-rule-catalog';

export type { GuardrailRuleAction } from './output-rule.types';
export {
  OUTPUT_RULE_CATALOG,
  OUTPUT_RULE_IDS,
  type OutputRuleCatalogMetadata,
} from './rules/output-rule-catalog';

/**
 * Reply 后置事实对账。
 *
 * 设计目的：拦截 Agent 在确认轮 / 收尾轮"自由发挥"——即没有真正调任何工具
 * 却声称动态事实（群人数、库存、距离、薪资）。历史 badcase i41pab8n：
 * 上一轮 invite_to_group 已成功，本轮用户回"好的"，Agent 无 tool 调用
 * 编出"群里人数满了"。
 *
 * 规则按 catalog action 决定处理方式：observe 只告警，revise/replan 会进入受控修复回路，
 * block 则直接拦截不发送。低确定性的体验类规则仍保留 observe。
 *
 * 阻断规则（action='block'）：歧视性筛选条件外露这类"发出去即不可挽回"
 * 的内容直接走出站短路，runner 丢弃回复不发送。
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
   * - false-promises 里的“名额承诺/拉群承诺”；
   * - discrimination-leaks 里的“敏感筛选条件外露”。
   *
   * 如果规则需要读取 tool.result 里的结构化字段，或需要生成动态 label，
   * 就不要塞进这个数组，而应写成 detectXxx 函数并在 check() 里显式编排。
   */
  private readonly rules: FactRule[] = [...FALSE_PROMISE_RULES, ...DISCRIMINATION_LEAK_RULES];

  private readonly rulePolicyById = new Map<string, OutputRuleCatalogMetadata>(
    OUTPUT_RULE_CATALOG.map((rule) => [rule.id, rule]),
  );

  constructor(private readonly replyFactGuardNotifier: ReplyFactGuardNotifierService) {}

  /**
   * 检查 reply 是否与本轮 tool 调用矛盾。
   *
   * - observe 规则：命中即日志 + 落库 guardrail_review_records（不写飞书），内容仍可发送
   * - revise/replan 规则：当前回复不可发送，由 OutputGuardrail/runner 进入受控修复
   * - block 规则：当前回复不可发送且不可恢复，调用方必须丢弃本轮回复
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
    /** 本轮入口记忆事实，用于跨轮身份红线对账。 */
    memorySnapshot?: AgentMemorySnapshot;
    /** 静默模式（advisory）：命中不 fire 飞书 badcase 告警，只返回裁决。 */
    silent?: boolean;
  }): {
    hit: boolean;
    contradictions: RuleContradiction[];
  } {
    const text = params.replyText ?? '';
    if (!text.trim()) return { hit: false, contradictions: [] };

    const toolCalls = params.toolCalls ?? [];
    const contradictions: RuleContradiction[] = [];

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

    const identityMisregistrationCoaching = detectIdentityMisregistrationCoaching(
      text,
      toolCalls,
      params.memorySnapshot,
      params.userMessage,
    );
    if (identityMisregistrationCoaching) {
      contradictions.push(this.withRulePolicy(identityMisregistrationCoaching));
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

    if (contradictions.length === 0) return { hit: false, contradictions: [] };

    const hasNonSendable = contradictions.some((c) => c.currentReplySendable === false);
    const hasRepair = contradictions.some(
      (c) => c.action === GUARDRAIL_ACTION.REVISE || c.action === GUARDRAIL_ACTION.BLOCK,
    );
    const actionLabel = hasNonSendable ? 'veto_current_reply' : hasRepair ? 'repair' : 'warn';

    this.logger.warn(
      `[ReplyFactGuard] 命中事实矛盾: chatId=${params.chatId ?? '-'}, userId=${params.userId ?? '-'}, action=${
        actionLabel
      }, rules=${contradictions
        .map((c) => c.ruleId)
        .join(',')}, replyPreview="${text.slice(0, 80)}"${params.silent ? ' [silent]' : ''}`,
    );

    // silent（advisory 调试流量）：只返回裁决，不 fire 飞书 badcase，避免污染生产判例。
    if (params.silent) return { hit: true, contradictions };

    // observe 档（currentReplySendable=true）判例已全量落 guardrail_review_records，
    // 飞书 badcase 只保留 enforce（revise/replan/block，不可发送）判例：观察类只用于离线
    // 校准精确率，从库里查即可，不再写多维表/告警，避免刷屏污染人工排查池。
    const enforceContradictions = contradictions.filter((c) => c.currentReplySendable === false);
    if (enforceContradictions.length === 0) return { hit: true, contradictions };

    // 飞书告警 fire-and-forget——不阻塞回复链路；阻断规则均已拦截、未发送给候选人
    void this.replyFactGuardNotifier
      .notifyContradiction({
        chatId: params.chatId,
        userId: params.userId,
        traceId: params.traceId,
        contactName: params.contactName,
        botImId: params.botImId,
        botUserName: params.botUserName,
        userMessage: params.userMessage,
        replyPreview: text.slice(0, 400),
        contradictions: enforceContradictions.map((c) => ({
          ...c,
          label: `【已拦截，未发送给候选人】${c.label}`,
        })),
        toolNames: toolCalls.map((c) => c.toolName),
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`[ReplyFactGuard] 飞书告警发送失败: ${message}`);
      });

    return { hit: true, contradictions };
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

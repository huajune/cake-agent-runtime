import type { AgentToolCall } from '@agent/generator/generator.types';
import type {
  GuardrailAction,
  GUARDRAIL_ACTION,
  GuardrailDataSensitivity,
  GuardrailFeedbackPolicy,
  GuardrailPriority,
  GuardrailRecoverability,
  GuardrailRepairMode,
} from '@shared-types/guardrail.contract';

/**
 * 由 action 派生 recoverability / currentReplySendable / repairMode。
 * catalog 和 withRulePolicy 统一调用，消除三个派生字段的手动维护。
 */
export function deriveRulePolicy(action: GuardrailRuleAction): {
  currentReplySendable: boolean;
  recoverability: GuardrailRecoverability;
  repairMode: GuardrailRepairMode;
} {
  switch (action) {
    case 'observe':
      return { currentReplySendable: true, recoverability: 'recoverable', repairMode: 'rewrite' };
    case 'revise':
      return { currentReplySendable: false, recoverability: 'recoverable', repairMode: 'rewrite' };
    case 'block':
      return {
        currentReplySendable: false,
        recoverability: 'non_recoverable',
        repairMode: 'rewrite',
      };
  }
}

/**
 * 确定性规则命中后的处理语义（`GuardrailAction` 的输出层子集）。
 *
 * 优先级（严重度递增）：observe < revise < block
 * - observe：发现软性问题，内容仍可发，只记录告警（发牌制缺省档，评估文档 §2.2）；
 * - revise：内容不可发，LLM 受约束重写被点名句即可修复；
 * - block：内容不可发，高风险且不可 fail-open；runner 仍先尝试一次受控重写，救不活才硬拦。
 *
 * REPLAN 不在本联合类型内（2026-07-27 发牌切换收尾退役，硬规则目录零雇主）：
 * "重新规划整段回复"不是任何规则可声明的修复方式——三期审计证明该机制是全部
 * 已投递伤害的宿主（docs/architecture/guardrail-quality-system.md §2）。
 * 未来需要"补取事实"式修复的规则，走 §2.4 条件项两步拆解（取数归 generator、
 * 写字归 ReplyRepairAgent），必须先修订该文档再扩本类型。
 *
 * `recoverability`、`currentReplySendable`、`repairMode` 均由 action 派生，
 * 不再作为 catalog 字段手动维护。
 */
export type GuardrailRuleAction = Extract<
  GuardrailAction,
  typeof GUARDRAIL_ACTION.OBSERVE | typeof GUARDRAIL_ACTION.REVISE | typeof GUARDRAIL_ACTION.BLOCK
>;

export interface OutputRulePolicy {
  severity: GuardrailPriority;
  dataSensitivity: GuardrailDataSensitivity;
  feedbackPolicy: GuardrailFeedbackPolicy;
  feedbackToGenerator: string;
  /** replan 退役（2026-07-27）后恒为空；字段保留兼容历史档案与 §2.4 未来重新申领动手权。 */
  repairToolNames?: readonly string[];
}

/**
 * 单条规则命中结果。
 *
 * label 面向研发/运营告警，应该写清楚“为什么命中”和“应改成什么口径”；
 * action 面向机器决策，决定 OutputGuardrail 最终 pass/revise/block。
 */
export interface RuleContradiction {
  ruleId: string;
  label: string;
  action: GuardrailRuleAction;
  severity?: GuardrailPriority;
  dataSensitivity?: GuardrailDataSensitivity;
  recoverability?: GuardrailRecoverability;
  currentReplySendable?: boolean;
  feedbackPolicy?: GuardrailFeedbackPolicy;
  repairMode?: GuardrailRepairMode;
  feedbackToGenerator?: string;
  repairToolNames?: readonly string[];
}

/**
 * 简单正则规则定义。
 *
 * 适用场景：
 * - 只需要看 reply 文本 + 一个“本轮工具是否已成功”的布尔条件；
 * - 例如名额承诺、性别拒绝、工作内容泛化。
 *
 * 不适用场景：
 * - 需要读取工具 result 里的结构化字段；
 * - 需要返回动态 label（比如 errorType、缺失字段名）。
 *
 * 那些复杂规则应写成独立 detectXxx 函数，并由 hard-rules.service 显式调度。
 */
export interface FactRule {
  ruleId: string;
  label: string;
  keywords: RegExp;
  ignorePredicate?: (text: string, toolCalls: AgentToolCall[]) => boolean;
  requiredToolPredicate: (toolCalls: AgentToolCall[]) => boolean;
  action: GuardrailRuleAction;
}

/** 兼容既有守卫规则引用；实现统一收拢到 infra 工具。 */
export { asRecord } from '@infra/utils/object.util';

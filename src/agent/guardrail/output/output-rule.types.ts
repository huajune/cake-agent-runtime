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
    case 'replan':
      return { currentReplySendable: false, recoverability: 'recoverable', repairMode: 'replan' };
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
 * 优先级（严重度递增）：observe < revise < replan < block
 * - observe：发现软性问题，内容仍可发，只记录告警；
 * - revise：内容不可发，LLM 重写文案即可修复；
 * - replan：内容不可发，LLM 需重走工具调用再生成；
 * - block：内容不可发，高风险且不可 fail-open；runner 仍先尝试一次受控重写，救不活才硬拦。
 *
 * `recoverability`、`currentReplySendable`、`repairMode` 均由 action 派生，
 * 不再作为 catalog 字段手动维护。
 */
export type GuardrailRuleAction = Extract<
  GuardrailAction,
  | typeof GUARDRAIL_ACTION.OBSERVE
  | typeof GUARDRAIL_ACTION.REVISE
  | typeof GUARDRAIL_ACTION.REPLAN
  | typeof GUARDRAIL_ACTION.BLOCK
>;

export interface OutputRulePolicy {
  severity: GuardrailPriority;
  dataSensitivity: GuardrailDataSensitivity;
  feedbackPolicy: GuardrailFeedbackPolicy;
  feedbackToGenerator: string;
  /** replan 时允许恢复阶段调用的最小工具集合；非 replan 规则默认为空。 */
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

/**
 * 安全地把 unknown 工具结果转成普通对象。
 * 工具返回历史格式较杂，规则里统一用它读取字段，避免 null/数组/primitive 误访问。
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

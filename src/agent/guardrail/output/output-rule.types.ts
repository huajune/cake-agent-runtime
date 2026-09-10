import type { AgentToolCall } from '@agent/generator/generator.types';
import type { OutputRuleId } from './output-rule-catalog';
import type {
  GuardrailAction,
  GUARDRAIL_ACTION,
  GuardrailDataSensitivity,
  GuardrailFeedbackPolicy,
  GuardrailPriority,
  GuardrailRepairMode,
} from '@shared-types/guardrail.contract';

/**
 * 由草稿处理动作派生 currentReplySendable / repairMode。
 * allowFailOpen 由目录独立声明，不随 repair 动作放松。
 */
export function deriveRulePolicy(action: GuardrailRuleAction): {
  currentReplySendable: boolean;
  repairMode: GuardrailRepairMode;
} {
  switch (action) {
    case 'observe':
      return { currentReplySendable: true, repairMode: 'rewrite' };
    case 'repair':
      return { currentReplySendable: false, repairMode: 'rewrite' };
    case 'replan':
      return { currentReplySendable: false, repairMode: 'replan' };
  }
}

/**
 * 确定性规则命中后的处理语义（`GuardrailAction` 的输出层子集）。
 *
 * 处理优先级：observe < repair < replan；风险等级和 fail-open 资格独立于处理方式。
 * - observe：发现软性问题，内容仍可发，只记录告警（发牌制缺省档，评估文档 §2.2）；
 * - repair：当前草稿不可发，由 Runner 选择机械清理或无工具改写；
 * - replan：内容不可发，且问题不在文案而在"该发生的查询没发生"（零工具轮编造岗位事实）；
 *   文本层修不出没发生过的查询，runner 用相同参数重进一次 generator；
 *
 * replan 档不带 repairToolNames：2026-07 的旧实现是"带守卫反馈 + 只读工具白名单"的重写器，改目标
 * 函数又裁工具，07-27 删除；现行实现只是同参重掷，规则不得再声明工具白名单。
 *
 * `currentReplySendable`、`repairMode` 由 action 派生，
 * `allowFailOpen` 独立描述未消除该违规时是否允许有条件放行。
 */
export type GuardrailRuleAction = Extract<
  GuardrailAction,
  typeof GUARDRAIL_ACTION.OBSERVE | typeof GUARDRAIL_ACTION.REPAIR | typeof GUARDRAIL_ACTION.REPLAN
>;

export interface OutputRulePolicy {
  allowFailOpen: boolean;
  severity: GuardrailPriority;
  dataSensitivity: GuardrailDataSensitivity;
  feedbackPolicy: GuardrailFeedbackPolicy;
  feedbackToGenerator: string;
  /** 当前恒为空；字段仅用于兼容历史档案与 §2.4 的未来扩展。 */
  repairToolNames?: readonly string[];
}

/**
 * 单条规则命中结果。
 *
 * label 面向研发/运营告警，应该写清楚“为什么命中”和“应改成什么口径”；
 * action 面向草稿处理；最终投递、静默或人工介入由 Runner 决定。
 */
export interface RuleContradiction {
  ruleId: OutputRuleId;
  label: string;
  action: GuardrailRuleAction;
  severity?: GuardrailPriority;
  dataSensitivity?: GuardrailDataSensitivity;
  allowFailOpen?: boolean;
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
  ruleId: OutputRuleId;
  label: string;
  keywords: RegExp;
  ignorePredicate?: (text: string, toolCalls: AgentToolCall[]) => boolean;
  requiredToolPredicate: (toolCalls: AgentToolCall[]) => boolean;
}

/**
 * 安全地把 unknown 工具结果转成普通对象。
 * 工具返回历史格式较杂，规则里统一用它读取字段，避免 null/数组/primitive 误访问。
 * 实现已收拢至 `@infra/utils/object.util`，此处保留规则侧的既有导入路径。
 */
export { asRecord } from '@infra/utils/object.util';

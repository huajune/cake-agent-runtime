/**
 * 中立 Guardrail 契约（破环关键）。
 *
 * `agent/guardrail/*`（input/output 决策层）与物理留在 `tools/` 的 tool guardrail
 * （BookingGuardrail 等）共用本契约。tools 不反向依赖 agent，二者都只 import 本中立层，
 * 故 `agent → tools` 单向、无环（见 [agent-reliability-refactor-2026-06.md] §7）。
 *
 * 设计要点（§2.5 设计铁律）：
 * - guardrail 是**决策层**：只读、有否决权、决策是 veto 而非建议。
 * - 每条 guardrail 必须带"新外生信号"（ground truth / 接地的 toolCalls.result / 红线），
 *   否则在决策论上被中心化决策者支配，堆多了准确率反而崩——catalog 用 `exogenousSignal`
 *   字段把这条规矩落到可审计。
 */

export type GuardrailLayer = 'input' | 'tool' | 'output';

/** Guardrail 生效点：用于审计是否存在绕过路径。 */
export type GuardrailStage =
  | 'input_pre_agent'
  | 'agent_reasoning'
  | 'tool_runtime'
  | 'output_pre_send'
  | 'memory_write'
  | 'ops_handoff';

/** 运营/验收视角的执行动作。 */
export type GuardrailAction =
  | 'prompt_only'
  | 'observe'
  | 'revise'
  | 'block'
  | 'pause_hosting'
  | 'reject_collect'
  | 'reject_hard';

/** 护栏缺口治理优先级：P0 会形成合规/资金/信任硬风险，P2 多为体验或观测增强。 */
export type GuardrailPriority = 'P0' | 'P1' | 'P2';

/** 覆盖来源：避免把 prompt-only 误算成代码兜底。 */
export type GuardrailCoverage = 'code' | 'hybrid' | 'prompt_only' | 'planned';

/**
 * 统一决策枚举（按层取子集）：
 * - input：`pass | block`
 * - tool ：`allow | reject_collect | reject_hard`
 * - output：`pass | revise | block`
 */
export type GuardrailDecision =
  | 'pass'
  | 'revise'
  | 'replan'
  | 'block'
  | 'allow'
  | 'reject_collect'
  | 'reject_hard';

/** Input 层决策子集。 */
export type InputDecision = Extract<GuardrailDecision, 'pass' | 'block'>;

/** Output 层决策子集。 */
export type OutputDecision = Extract<GuardrailDecision, 'pass' | 'revise' | 'replan' | 'block'>;

/** Input 层风险类型码（对应 risk-intercept.service 的检测分类）。 */
export type InputRiskType = 'abuse' | 'complaint_risk' | 'interview_result_inquiry';

export type GuardrailRiskLevel = 'low' | 'medium' | 'high';

/** 被命中内容本身的数据敏感等级；不要和风险严重度混用。 */
export type GuardrailDataSensitivity = 'none' | 'normal' | 'high';

/** 命中后是否能通过受控修复继续本回合。 */
export type GuardrailRecoverability = 'recoverable' | 'non_recoverable';

/** 反馈给 generator 时的脱敏策略。 */
export type GuardrailFeedbackPolicy = 'none' | 'plain_policy' | 'redacted';

/** 修复方式：纯文案重写，或允许重新规划并调用只读工具。 */
export type GuardrailRepairMode = 'rewrite' | 'replan';

/** 单条违规意见（HC-1 revise 回路注入用）。 */
export interface GuardViolation {
  type:
    | 'hallucinated_fact'
    | 'unsupported_commitment'
    | 'policy_violation'
    | 'bad_tone'
    | 'wrong_stage'
    | 'intent_mismatch'
    // 允许 catalog 外的规则 id 透传，又保留上面字面量的提示。
    | (string & Record<never, never>);
  evidence: string;
  suggestion: string;
  severity?: GuardrailPriority;
  dataSensitivity?: GuardrailDataSensitivity;
  recoverability?: GuardrailRecoverability;
  currentReplySendable?: boolean;
  feedbackPolicy?: GuardrailFeedbackPolicy;
  repairMode?: GuardrailRepairMode;
}

export interface GuardVerdict {
  decision: GuardrailDecision;
  riskLevel?: GuardrailRiskLevel;
  violations?: GuardViolation[];
  /** tool/handoff 路径的稳定原因码（用于幂等键、观测、转人工归因）。 */
  reasonCode?: string;
}

/** 一个 guardrail 单元的统一形状（只读、有否决权）。 */
export interface Guardrail<TInput = unknown> {
  readonly id: string;
  readonly layer: GuardrailLayer;
  check(input: TInput): GuardVerdict | Promise<GuardVerdict>;
}

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

/**
 * 统一决策枚举（按层取子集）：
 * - input：`pass | block`
 * - tool ：`allow | reject_collect | reject_hard`
 * - output：`pass | revise | block`
 */
export type GuardrailDecision =
  | 'pass'
  | 'revise'
  | 'block'
  | 'allow'
  | 'reject_collect'
  | 'reject_hard';

export type GuardrailRiskLevel = 'low' | 'medium' | 'high';

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
    | (string & {});
  evidence: string;
  suggestion: string;
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

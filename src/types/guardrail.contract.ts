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

export const GUARDRAIL_LAYER = {
  INPUT: 'input',
  TOOL: 'tool',
  OUTPUT: 'output',
} as const;

export const GUARDRAIL_LAYERS = Object.values(GUARDRAIL_LAYER);

export type GuardrailLayer = (typeof GUARDRAIL_LAYERS)[number];

/** Guardrail 生效点：用于审计是否存在绕过路径。 */
export const GUARDRAIL_STAGE = {
  INPUT_PRE_AGENT: 'input_pre_agent',
  AGENT_REASONING: 'agent_reasoning',
  TOOL_RUNTIME: 'tool_runtime',
  OUTPUT_PRE_SEND: 'output_pre_send',
  MEMORY_WRITE: 'memory_write',
  OPS_HANDOFF: 'ops_handoff',
} as const;

export const GUARDRAIL_STAGES = Object.values(GUARDRAIL_STAGE);

export type GuardrailStage = (typeof GUARDRAIL_STAGES)[number];

/** 运营/验收视角的执行动作。 */
export const GUARDRAIL_ACTION = {
  PROMPT_ONLY: 'prompt_only',
  OBSERVE: 'observe',
  REVISE: 'revise',
  REPLAN: 'replan',
  BLOCK: 'block',
  PAUSE_HOSTING: 'pause_hosting',
  REJECT_COLLECT: 'reject_collect',
  REJECT_HARD: 'reject_hard',
} as const;

export const GUARDRAIL_ACTIONS = Object.values(GUARDRAIL_ACTION);

export type GuardrailAction = (typeof GUARDRAIL_ACTIONS)[number];

/** 护栏缺口治理优先级：P0 会形成合规/资金/信任硬风险，P2 多为体验或观测增强。 */
export const GUARDRAIL_PRIORITY = {
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
} as const;

export const GUARDRAIL_PRIORITIES = Object.values(GUARDRAIL_PRIORITY);

export type GuardrailPriority = (typeof GUARDRAIL_PRIORITIES)[number];

/** 覆盖来源：避免把 prompt-only 误算成代码兜底。 */
export const GUARDRAIL_COVERAGE = {
  CODE: 'code',
  HYBRID: 'hybrid',
  PROMPT_ONLY: 'prompt_only',
  PLANNED: 'planned',
} as const;

export const GUARDRAIL_COVERAGES = Object.values(GUARDRAIL_COVERAGE);

export type GuardrailCoverage = (typeof GUARDRAIL_COVERAGES)[number];

/**
 * 统一决策枚举（按层取子集）：
 * - input：`pass | block`
 * - tool ：`allow | reject_collect | reject_hard`
 * - output：`pass | observe | revise | replan | block`
 *
 * output 层优先级（严重度递增）：pass < observe < revise < replan < block
 * - pass：无违规，内容可发
 * - observe：发现软性问题，内容仍可发，打标记录
 * - revise：内容不可发，LLM 重写文案
 * - replan：内容不可发，LLM 重走工具再生成
 * - block：内容不可发，不修复，硬拦
 */
export const GUARDRAIL_DECISION = {
  PASS: 'pass',
  OBSERVE: 'observe',
  REVISE: 'revise',
  REPLAN: 'replan',
  BLOCK: 'block',
  ALLOW: 'allow',
  REJECT_COLLECT: 'reject_collect',
  REJECT_HARD: 'reject_hard',
} as const;

export const GUARDRAIL_DECISIONS = Object.values(GUARDRAIL_DECISION);

export type GuardrailDecision = (typeof GUARDRAIL_DECISIONS)[number];

/** Input 层决策子集。 */
export type InputDecision = Extract<
  GuardrailDecision,
  typeof GUARDRAIL_DECISION.PASS | typeof GUARDRAIL_DECISION.BLOCK
>;

/** Output 层决策子集。 */
export type OutputDecision = Extract<
  GuardrailDecision,
  | typeof GUARDRAIL_DECISION.PASS
  | typeof GUARDRAIL_DECISION.OBSERVE
  | typeof GUARDRAIL_DECISION.REVISE
  | typeof GUARDRAIL_DECISION.REPLAN
  | typeof GUARDRAIL_DECISION.BLOCK
>;

/** Input 层风险类型码（对应 risk-intercept.service 的检测分类）。 */
export const INPUT_RISK_TYPE = {
  ABUSE: 'abuse',
  COMPLAINT_RISK: 'complaint_risk',
  INTERVIEW_RESULT_INQUIRY: 'interview_result_inquiry',
  /** 候选人主动明确要求转人工（badcase 6a5df7e7：礼貌要人工无响应，升级辱骂才触发拦截）。 */
  HUMAN_HANDOFF_REQUEST: 'human_handoff_request',
} as const;

export const INPUT_RISK_TYPES = Object.values(INPUT_RISK_TYPE);

export type InputRiskType = (typeof INPUT_RISK_TYPES)[number];

export const GUARDRAIL_RISK_LEVEL = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;

export const GUARDRAIL_RISK_LEVELS = Object.values(GUARDRAIL_RISK_LEVEL);

export type GuardrailRiskLevel = (typeof GUARDRAIL_RISK_LEVELS)[number];

/** 被命中内容本身的数据敏感等级；不要和风险严重度混用。 */
export const GUARDRAIL_DATA_SENSITIVITY = {
  NONE: 'none',
  NORMAL: 'normal',
  HIGH: 'high',
} as const;

export const GUARDRAIL_DATA_SENSITIVITIES = Object.values(GUARDRAIL_DATA_SENSITIVITY);

export type GuardrailDataSensitivity = (typeof GUARDRAIL_DATA_SENSITIVITIES)[number];

/** 命中后是否能通过受控修复继续本回合。 */
export const GUARDRAIL_RECOVERABILITY = {
  RECOVERABLE: 'recoverable',
  NON_RECOVERABLE: 'non_recoverable',
} as const;

export const GUARDRAIL_RECOVERABILITIES = Object.values(GUARDRAIL_RECOVERABILITY);

export type GuardrailRecoverability = (typeof GUARDRAIL_RECOVERABILITIES)[number];

/** 反馈给 generator 时的脱敏策略。 */
export const GUARDRAIL_FEEDBACK_POLICY = {
  NONE: 'none',
  PLAIN_POLICY: 'plain_policy',
  REDACTED: 'redacted',
} as const;

export const GUARDRAIL_FEEDBACK_POLICIES = Object.values(GUARDRAIL_FEEDBACK_POLICY);

export type GuardrailFeedbackPolicy = (typeof GUARDRAIL_FEEDBACK_POLICIES)[number];

/** 修复方式：纯文案重写，或允许重新规划并调用只读工具。 */
export const GUARDRAIL_REPAIR_MODE = {
  REWRITE: 'rewrite',
  REPLAN: 'replan',
} as const;

export const GUARDRAIL_REPAIR_MODES = Object.values(GUARDRAIL_REPAIR_MODE);

export type GuardrailRepairMode = (typeof GUARDRAIL_REPAIR_MODES)[number];

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

/**
 * 出站守卫单次审查的紧凑摘要（观测/落库用）。
 *
 * 刻意不带 violations 证据/建议全文：这份结构会随每条 turn 写进
 * `message_processing_records.guardrail` 列，必须保持 KB 级（ttft deTOAST 教训）；
 * 证据全文只进调试链路（debug-chat / test-suite trace）。
 */
export interface GuardrailReviewStepTrace {
  /** first=首版审查；revised=受控修复后的二审。 */
  stage: 'first' | 'revised';
  decision: OutputDecision;
  riskLevel: GuardrailRiskLevel;
  /** 本次命中的全部 rule id（含 observe，供观测）。 */
  ruleIds: string[];
  /** 当前回复不可发送的 rule id。 */
  blockedRuleIds: string[];
  /** 违规意见的 type（rule id / semantic finding code），不含证据文本。 */
  violationTypes: string[];
  repairMode: GuardrailRepairMode;
  reasonCode?: string;
}

/**
 * 一个回合的出站守卫全程 trace（首审 → 受控修复 → 二审）。
 *
 * runner.invokeReviewed 产出，随 turn 流水写入 `message_processing_records.guardrail_output`，
 * 支撑流水页 runtime 过程展示与触发率/enforce 率/repair 成功率聚合。
 */
export interface GuardrailTurnTrace {
  steps: GuardrailReviewStepTrace[];
  /** 是否触发过一次受控修复（revise/replan 重写）。 */
  repaired: boolean;
  /** 最终裁决（可能被 repair 上限收敛覆盖，如 repair_exhausted → block）。 */
  finalDecision: OutputDecision;
  reasonCode?: string;
}

/**
 * 入站守卫拦截摘要（写入 `message_processing_records.guardrail_input`，仅拦截命中时非空）。
 * 与 runner `TurnOutcome.intercept` 对应：本轮不跑 Agent，guardrail 内部已 dispatch 人工介入。
 */
export interface GuardrailInputTrace {
  decision: InputDecision;
  riskType?: string;
  riskLabel?: string;
  reason?: string;
  reasonCode?: string;
}

/** 一个 guardrail 单元的统一形状（只读、有否决权）。 */
export interface Guardrail<TInput = unknown> {
  readonly id: string;
  readonly layer: GuardrailLayer;
  check(input: TInput): GuardVerdict | Promise<GuardVerdict>;
}

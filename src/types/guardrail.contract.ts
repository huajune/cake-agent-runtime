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
 * - output：`pass | observe | revise | replan | block`（replan 已于 2026-07-27 退役，
 *   枚举值保留仅容忍历史档案与模型输出，落地前一律折叠为 revise）
 *
 * output 层优先级（严重度递增）：pass < observe < revise < replan < block
 * - pass：无违规，内容可发
 * - observe：发现软性问题，内容仍可发，打标记录
 * - revise：内容不可发，LLM 重写文案
 * - replan：（退役）历史语义为重走工具再生成，现流程折叠为 revise
 * - block：内容不可发；runner 先做一次受控重写自救，二审仍违规才硬拦
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

/**
 * OutputDecision 的**有序**元组。语义严重度升序（pass → block），语义审查的
 * z.enum 与优先级合并都以此为准。
 *
 * 为什么单列而不用 GUARDRAIL_DECISIONS：后者混了 input 层的 allow/reject_*，
 * 不是 output 层的合法取值集。
 */
export const OUTPUT_DECISIONS = [
  GUARDRAIL_DECISION.PASS,
  GUARDRAIL_DECISION.OBSERVE,
  GUARDRAIL_DECISION.REVISE,
  GUARDRAIL_DECISION.REPLAN,
  GUARDRAIL_DECISION.BLOCK,
] as const;

// 元组与 OutputDecision 成员集合恒等的编译期证明（任一方增删档位即报错）。
type _AssertOutputDecisionsCover =
  Exclude<OutputDecision, (typeof OUTPUT_DECISIONS)[number]> extends never ? true : never;
type _AssertOutputDecisionsNoExtra =
  Exclude<(typeof OUTPUT_DECISIONS)[number], OutputDecision> extends never ? true : never;
const _outputDecisionParity: [_AssertOutputDecisionsCover, _AssertOutputDecisionsNoExtra] = [
  true,
  true,
];
void _outputDecisionParity;

/** Input 层风险类型码（对应 risk-intercept.service 的检测分类）。 */
export const INPUT_RISK_TYPE = {
  ABUSE: 'abuse',
  COMPLAINT_RISK: 'complaint_risk',
  INTERVIEW_RESULT_INQUIRY: 'interview_result_inquiry',
  /** 候选人主动明确要求转人工（badcase 6a5df7e7：礼貌要人工无响应，升级辱骂才触发拦截）。 */
  HUMAN_HANDOFF_REQUEST: 'human_handoff_request',
  /**
   * 候选人主动披露残障身份或询问残障者能否应聘（badcase gkaszeip/zmuhev8o 簇）。
   * 产品+运营裁定（2026-07-28）：一律静默转人工，由真人判断沟通方式；
   * Agent 不得输出任何自动话术——"委婉拒绝"属残障就业歧视，法律红线，绝不自动化。
   */
  DISABILITY_DISCLOSURE: 'disability_disclosure',
} as const;

export const INPUT_RISK_TYPES = Object.values(INPUT_RISK_TYPE);

export type InputRiskType = (typeof INPUT_RISK_TYPES)[number];

export const GUARDRAIL_RISK_LEVEL = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;

/**
 * 有序元组（低→高）。刻意不用 `Object.values()`：那返回可变数组，`z.enum` 要
 * readonly tuple；而语义审查的 confidence 字段正是靠它生成模型可见 schema。
 * 下方类型断言保证元组与 GUARDRAIL_RISK_LEVEL 成员集合恒等。
 */
export const GUARDRAIL_RISK_LEVELS = [
  GUARDRAIL_RISK_LEVEL.LOW,
  GUARDRAIL_RISK_LEVEL.MEDIUM,
  GUARDRAIL_RISK_LEVEL.HIGH,
] as const;

export type GuardrailRiskLevel = (typeof GUARDRAIL_RISK_LEVELS)[number];

type _AssertRiskLevelsCover =
  Exclude<
    (typeof GUARDRAIL_RISK_LEVEL)[keyof typeof GUARDRAIL_RISK_LEVEL],
    GuardrailRiskLevel
  > extends never
    ? true
    : never;
const _riskLevelParity: _AssertRiskLevelsCover = true;
void _riskLevelParity;

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

/** 有序元组（理由同 GUARDRAIL_RISK_LEVELS：z.enum 需要 readonly tuple）。 */
export const GUARDRAIL_REPAIR_MODES = [
  GUARDRAIL_REPAIR_MODE.REWRITE,
  GUARDRAIL_REPAIR_MODE.REPLAN,
] as const;

export type GuardrailRepairMode = (typeof GUARDRAIL_REPAIR_MODES)[number];

type _AssertRepairModesCover =
  Exclude<
    (typeof GUARDRAIL_REPAIR_MODE)[keyof typeof GUARDRAIL_REPAIR_MODE],
    GuardrailRepairMode
  > extends never
    ? true
    : never;
const _repairModeParity: _AssertRepairModesCover = true;
void _repairModeParity;

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
 * `message_processing_records.guardrail_output` 列，必须保持 KB 级（ttft deTOAST 教训）；
 * 证据全文另落 guardrail_review_records（生产与调试链路通用）。
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
 * 与 runner `TurnOutcome.kind==='guardrail_blocked'`（phase='inbound'）对应：本轮不跑 Agent；
 * guardrail 只声明 sideEffects 意图，人工介入由渠道侧 TurnOutcomeInterventionService.commit 执行。
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

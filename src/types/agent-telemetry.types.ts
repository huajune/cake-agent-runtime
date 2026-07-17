/**
 * Agent telemetry contracts shared across agent/biz/channel/tracking layers.
 *
 * These shapes are serialized into observability records and should remain
 * decoupled from agent-internal orchestration modules.
 */

/**
 * 工具调用状态
 * - ok: 正常返回（结果条数 >= 1 且非搜索类单结果，或工具成功标记为 true）
 * - empty: 返回 0 条（工具命中逻辑失败或过滤过严）
 * - narrow: 搜索类工具仅返回 1 条（候选人可能没的选；非搜索类单结果记 ok）
 * - unknown: 返回成功但结果结构无法推断条数
 * - error: 工具抛异常 / 返回 errorType、error 字段或成功标记为 false
 */
export type AgentToolCallStatus = 'ok' | 'empty' | 'narrow' | 'unknown' | 'error';

export interface AgentToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  /** 结果条数（优先取工具自报的 resultCount 字段，其次从数组/items/total 等形态推断，推断不出则 undefined） */
  resultCount?: number;
  /** 调用状态分类 */
  status?: AgentToolCallStatus;
  /**
   * 工具 execute 真实执行耗时（毫秒，由 timing wrapper 按 toolCallId 记录）。
   * 历史数据/wrapper 缺失时退化为步骤墙钟近似（含 LLM 思考时间，偏大）。
   */
  durationMs?: number;
}

/** 每一步模型循环的详细快照：用于排查"模型两次调用之间想了什么"。 */
export interface AgentStepDetail {
  stepIndex: number;
  text?: string;
  reasoning?: string;
  toolCalls: AgentToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  durationMs?: number;
  finishReason?: string;
}

/** 本轮触发时的记忆上下文快照：用于判定"模型是否正确继承了上轮上下文"。 */
export interface AgentMemorySnapshot {
  /** 本轮入口阶段（来自 procedural.currentStage + recruitmentCase 解析） */
  currentStage: string | null;
  /** 本会话近几轮已展示给候选人的岗位 id 列表 */
  presentedJobIds: number[] | null;
  /** 上一轮 duliday_job_list 返回的候选池 jobId 列表 */
  recommendedJobIds: number[] | null;
  /** 已识别的会话事实（扁平化的 interview_info + preferences，仅留非空字段） */
  sessionFacts: Record<string, unknown> | null;
  /** 长期档案里已填充的字段名列表（不含值，避免 PII 泛滥） */
  profileKeys: string[] | null;
  /** 当前焦点岗位及精简记忆已经具备的详情字段；用于判断追问是否需要按 jobId 补查。 */
  currentFocusJob?: AgentFocusJobSnapshot | null;
}

export type AgentJobDetailField =
  | 'salary'
  | 'settlement'
  | 'shift'
  | 'welfare'
  | 'age_requirement'
  | 'education_requirement'
  | 'health_certificate_requirement'
  | 'student_requirement'
  | 'address'
  | 'interview_address'
  | 'employment'
  | 'duties'
  | 'duration';

export interface AgentFocusJobSnapshot {
  jobId: number;
  availableDetailFields: AgentJobDetailField[];
}

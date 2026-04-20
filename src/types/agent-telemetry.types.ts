/**
 * Agent telemetry contracts shared across agent/biz/channel/tracking layers.
 *
 * These shapes are serialized into observability records and should remain
 * decoupled from agent-internal orchestration modules.
 */

/**
 * 工具调用状态
 * - ok: 正常返回，结果条数 >= 2
 * - empty: 返回 0 条（工具命中逻辑失败或过滤过严）
 * - narrow: 仅返回 1 条（候选人可能没的选）
 * - unknown: 返回成功但结果结构无法推断条数
 * - error: 工具抛异常 / 返回 error 字段
 */
export type AgentToolCallStatus = 'ok' | 'empty' | 'narrow' | 'unknown' | 'error';

export interface AgentToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  /** 结果条数（从 result 数组 length / items / data / total / count 推断，推断不出则 undefined） */
  resultCount?: number;
  /** 调用状态分类 */
  status?: AgentToolCallStatus;
  /** 调用耗时（毫秒，best-effort；单工具/单步时较可靠） */
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
}

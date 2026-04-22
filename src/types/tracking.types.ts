/**
 * Tracking 服务类型定义
 * 消息处理生命周期追踪、Redis 实时计数
 */

import { ScenarioType } from '@enums/agent.enum';
import type {
  AgentMemorySnapshot,
  AgentStepDetail,
  AgentToolCall,
} from '@shared-types/agent-telemetry.types';

/**
 * 告警错误类型
 */
export type AlertErrorType = 'agent' | 'message' | 'delivery' | 'system' | 'merge' | 'unknown';

/**
 * 异常信号标签（写入时计算，供巡检/周报 SQL 直接过滤）
 *
 * - tool_loop: 同一工具被调用 ≥ 3 次（Case 1: duliday_job_list × 4）
 * - tool_empty_result: 有工具调用 resultCount = 0
 * - tool_narrow_result: 有工具调用 resultCount = 1（Case 2: 仅 1 条就收尾）
 * - tool_chain_overlong: 工具链总长 ≥ 5
 * - no_tool_called: 本轮没有调用任何工具（暂不自动打标，留给业务规则）
 */
export type AnomalyFlag =
  | 'tool_loop'
  | 'tool_empty_result'
  | 'tool_narrow_result'
  | 'tool_chain_overlong'
  | 'no_tool_called';

export interface PostProcessingStepStatus {
  name: string;
  status: 'success' | 'failure' | 'skipped';
  success: boolean;
  durationMs: number;
  error?: string;
  reason?: string;
}

export interface PostProcessingStatus {
  status: 'running' | 'completed' | 'completed_with_errors' | 'skipped';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  counts: {
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
  steps: PostProcessingStepStatus[];
}

/**
 * 监控元数据（随消息传递的追踪信息）
 */
export interface MonitoringMetadata {
  scenario?: ScenarioType;
  tokenUsage?: number;
  replyPreview?: string;
  replySegments?: number;
  isFallback?: boolean;
  alertType?: AlertErrorType;
  batchId?: string;
  /** 工具调用详情（写入 message_processing_records.tool_calls 列） */
  toolCalls?: AgentToolCall[];
  /** 每步循环快照（写入 message_processing_records.agent_steps 列） */
  agentSteps?: AgentStepDetail[];
  /** 本轮记忆上下文快照（写入 message_processing_records.memory_snapshot 列） */
  memorySnapshot?: AgentMemorySnapshot;
  /** turn-end 后处理状态（写入 message_processing_records.post_processing_status 列） */
  postProcessingStatus?: PostProcessingStatus;
  /** 异常信号标签（tracking 层根据 toolCalls 自动计算，调用方无需传） */
  anomalyFlags?: AnomalyFlag[];
  /** Agent 调用记录（完整的请求/响应，用于排障） */
  agentInvocation?: AgentInvocationRecord;
}

/**
 * Agent 调用记录（用于 Dashboard 排障）
 */
export interface AgentInvocationRecord {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  request: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: Record<string, any>;
  isFallback: boolean;
}

/**
 * 消息处理记录
 */
export interface MessageProcessingRecord {
  messageId: string;
  chatId: string;
  userId?: string;
  userName?: string;
  managerName?: string;
  scenario?: ScenarioType;

  // 时间戳
  receivedAt: number;
  aiStartAt?: number;
  aiEndAt?: number;
  sendStartAt?: number;
  sendEndAt?: number;

  // 耗时（毫秒）
  totalDuration?: number;
  aiDuration?: number;
  sendDuration?: number;
  queueDuration?: number;
  prepDuration?: number;

  // 状态
  status: 'processing' | 'success' | 'failure' | 'timeout';
  error?: string;
  isFallback?: boolean;
  fallbackSuccess?: boolean;

  // 消息内容（用于调试）
  messagePreview?: string;
  replyPreview?: string;
  tokenUsage?: number;
  replySegments?: number;
  alertType?: AlertErrorType;

  // 工具与记忆可观测性
  toolCalls?: AgentToolCall[];
  agentSteps?: AgentStepDetail[];
  anomalyFlags?: AnomalyFlag[];
  memorySnapshot?: AgentMemorySnapshot;
  postProcessingStatus?: PostProcessingStatus;

  // 聚合关系
  batchId?: string;

  /** Agent 调用记录 */
  agentInvocation?: AgentInvocationRecord;
}

/**
 * 错误日志
 */
export interface MonitoringErrorLog {
  messageId: string;
  timestamp: number;
  error: string;
  alertType?: AlertErrorType;
}

/**
 * Redis 全局计数器
 */
export interface MonitoringGlobalCounters {
  totalMessages: number;
  totalSuccess: number;
  totalFailure: number;
  totalAiDuration: number;
  totalSendDuration: number;
  totalFallback: number;
  totalFallbackSuccess: number;
}

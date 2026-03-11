/**
 * Tracking 服务类型定义
 * 消息处理生命周期追踪、Redis 实时计数
 */

import { ScenarioType } from '@agent';

/**
 * 告警错误类型
 */
export type AlertErrorType = 'agent' | 'message' | 'delivery' | 'system' | 'merge' | 'unknown';

/**
 * 监控元数据（随消息传递的追踪信息）
 */
export interface MonitoringMetadata {
  scenario?: ScenarioType;
  tools?: string[];
  tokenUsage?: number;
  replyPreview?: string;
  replySegments?: number;
  isFallback?: boolean;
  alertType?: AlertErrorType;
  batchId?: string;
  isPrimary?: boolean;
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
  status: 'processing' | 'success' | 'failure';
  error?: string;
  isFallback?: boolean;
  fallbackSuccess?: boolean;

  // 消息内容（用于调试）
  messagePreview?: string;
  replyPreview?: string;
  tokenUsage?: number;
  tools?: string[];
  replySegments?: number;
  alertType?: AlertErrorType;

  // 聚合关系
  batchId?: string;
  isPrimary?: boolean;

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

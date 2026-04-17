import type { AgentMemorySnapshot, AgentStepDetail, AgentToolCall } from '@agent/agent-run.types';
import type { AlertErrorType, AnomalyFlag } from '@shared-types/tracking.types';

/**
 * 聊天消息输入格式
 */
export interface ChatMessageInput {
  chatId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  candidateName?: string;
  managerName?: string;
  orgId?: string;
  botId?: string;
  messageType?: number;
  source?: number;
  isRoom?: boolean;
  imBotId?: string;
  imContactId?: string;
  contactType?: number;
  isSelf?: boolean;
  payload?: Record<string, unknown>;
  avatar?: string;
  externalUserId?: string;
}

/**
 * 会话摘要（分组后的结果）
 */
export interface ChatSessionSummary {
  chatId: string;
  candidateName?: string;
  managerName?: string;
  messageCount: number;
  lastMessage?: string;
  lastTimestamp?: number;
  avatar?: string;
  contactType?: string;
}

/**
 * 预约记录输入
 */
export interface BookingRecordInput {
  brandName?: string;
  storeName?: string;
  chatId?: string;
  userId?: string;
  userName?: string;
  managerId?: string;
  managerName?: string;
}

/**
 * 预约统计数据
 */
export interface BookingStats {
  date: string;
  brandName: string | null;
  storeName: string | null;
  bookingCount: number;
  chatId: string | null;
  userId: string | null;
  userName: string | null;
  managerId: string | null;
  managerName: string | null;
}

/**
 * 消息处理记录输入
 */
export interface MessageProcessingRecordInput {
  messageId: string;
  chatId: string;
  userId?: string;
  userName?: string;
  managerName?: string;
  receivedAt: number;
  messagePreview?: string;
  replyPreview?: string;
  replySegments?: number;
  status: 'processing' | 'success' | 'failure' | 'timeout';
  error?: string;
  alertType?: AlertErrorType;
  scenario?: string;
  totalDuration?: number;
  queueDuration?: number;
  prepDuration?: number;
  aiStartAt?: number;
  aiEndAt?: number;
  aiDuration?: number;
  ttftMs?: number;
  sendDuration?: number;
  tokenUsage?: number;
  isFallback?: boolean;
  fallbackSuccess?: boolean;
  agentInvocation?: unknown;
  batchId?: string;
  /** 工具调用详情：[{ name, args, result, resultCount, status, durationMs }, ...] */
  toolCalls?: AgentToolCall[];
  /** 每步循环快照 */
  agentSteps?: AgentStepDetail[];
  /** 异常信号标签（由 tracking 自动计算） */
  anomalyFlags?: AnomalyFlag[];
  /** 本轮触发时的记忆上下文快照 */
  memorySnapshot?: AgentMemorySnapshot;
}

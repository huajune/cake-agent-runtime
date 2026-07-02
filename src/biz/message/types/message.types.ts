import type {
  AgentMemorySnapshot,
  AgentStepDetail,
  AgentToolCall,
} from '@shared-types/agent-telemetry.types';
import type {
  AlertErrorType,
  AnomalyFlag,
  PostProcessingStatus,
} from '@shared-types/tracking.types';
import type { GuardrailInputTrace, GuardrailTurnTrace } from '@shared-types/guardrail.contract';

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
 * 消息处理记录输入
 */
export interface MessageProcessingRecordInput {
  messageId: string;
  chatId: string;
  userId?: string;
  userName?: string;
  managerName?: string;
  /** 托管账号系统 wxid（= bot_im_id），取自 botIdentity.imBotId */
  botImId?: string;
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
  /** 入站守卫拦截摘要（仅拦截命中时非空） */
  guardrailInput?: GuardrailInputTrace;
  /** 出站守卫全程 trace（首审→repair→二审，紧凑摘要） */
  guardrailOutput?: GuardrailTurnTrace;
  /** 本轮触发时的记忆上下文快照 */
  memorySnapshot?: AgentMemorySnapshot;
  /** turn-end 后处理状态 */
  postProcessingStatus?: PostProcessingStatus;
}

import type {
  AgentMemorySnapshot,
  AgentStepDetail,
  AgentToolCall,
} from '@shared-types/agent-telemetry.types';

export { AlertErrorType } from '@shared-types/tracking.types';

export interface FilterResult {
  pass: boolean;
  reason?: string;
  content?: string;
  details?: unknown;
  historyOnly?: boolean;
}

export interface PipelineResult<T = unknown> {
  continue: boolean;
  data?: T;
  reason?: string;
  response?: {
    success: boolean;
    message: string;
  };
}

export interface FallbackMessageOptions {
  customMessage?: string;
  random?: boolean;
}

export interface AgentReply {
  content: string;
  reasoning?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface AgentInvokeResult {
  reply: AgentReply;
  isFallback: boolean;
  processingTime: number;
  /** 扁平化的工具调用序列（含 resultCount/status/durationMs） */
  toolCalls?: AgentToolCall[];
  /** 每步循环快照 */
  agentSteps?: AgentStepDetail[];
  /** 本轮触发时的记忆上下文快照 */
  memorySnapshot?: AgentMemorySnapshot;
  responseMessages?: Array<Record<string, unknown>>;
}

export interface DeliveryContext {
  token: string;
  imBotId: string;
  imContactId: string;
  imRoomId: string;
  contactName: string;
  messageId: string;
  chatId: string;
  _apiType?: 'enterprise' | 'group';
}

export interface DeliveryResult {
  success: boolean;
  segmentCount: number;
  failedSegments: number;
  deliveredSegments?: number;
  totalTime: number;
  error?: string;
}

export class DeliveryFailureError extends Error {
  constructor(
    message: string,
    public readonly result: DeliveryResult,
  ) {
    super(message);
    this.name = 'DeliveryFailureError';
  }
}

export interface MessageSegment {
  content: string;
  index: number;
  total: number;
  isFirst: boolean;
  isLast: boolean;
}

export interface MessageHistoryItem {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface EnhancedMessageHistoryItem extends MessageHistoryItem {
  messageId: string;
  chatId: string;
  candidateName?: string;
  managerName?: string;
  orgId?: string;
  botId?: string;
}

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
  toolCalls?: Array<{ toolName: string; args: Record<string, unknown>; result?: unknown }>;
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

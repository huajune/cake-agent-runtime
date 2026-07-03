import type {
  AgentMemorySnapshot,
  AgentStepDetail,
  AgentToolCall,
} from '@shared-types/agent-telemetry.types';
import type { GuardrailTurnTrace } from '@shared-types/guardrail.contract';
import type { TurnOutcome } from '@agent/runner/agent-runner.types';
import type { TurnFinalizer } from '@agent/runner/turn-finalizer';

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
  /** Agent 本轮主动沉默（调用了 skip_reply 工具），reply.content 可能为空 */
  isSkipped?: boolean;
  /** guardrail_blocked 终态的归因；reply.content 仅供观测留痕，不得发送给候选人。 */
  guardrailBlocked?: TurnOutcome['guardrail'];
  processingTime: number;
  /** 扁平化的工具调用序列（含 resultCount/status/durationMs） */
  toolCalls?: AgentToolCall[];
  /** 每步循环快照 */
  agentSteps?: AgentStepDetail[];
  /** 出站守卫全程 trace（首审→repair→二审，写入 message_processing_records.guardrail_output 列） */
  guardrailOutput?: GuardrailTurnTrace;
  /** 本轮触发时的记忆上下文快照 */
  memorySnapshot?: AgentMemorySnapshot;
  responseMessages?: Array<Record<string, unknown>>;
  /**
   * 渠道无关的回合终态（由 runner 共享分类器 classifyReviewedOutcome 计算）：
   * reply→可投递，skipped/guardrail_blocked/handoff→不投递。投递/沉默分支据此判定，与 runner 主动链路同源。
   */
  outcome?: TurnOutcome;
  /**
   * 回合记忆收尾句柄（agent 层封装 deferTurnEnd 的编排不变式）。渠道只需在已知投递结局后调
   * `settle({ delivered })`、replay 丢弃时调 `discard()`、处理锁释放前 `await whenSettled()`，
   * 不再直接持有/编排 runTurnEnd 闭包。
   */
  turnFinalizer?: TurnFinalizer;
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
  /** 投递层主动跳过本次发送（内部实现泄漏 / 已暂停托管）。 */
  skipped?: boolean;
  /** 跳过原因，用于排障。 */
  skipReason?: 'output_leak' | 'hosting_paused';
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

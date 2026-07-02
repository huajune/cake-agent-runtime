import type {
  AgentMemorySnapshot,
  AgentStepDetail,
  AgentToolCall,
} from '@shared-types/agent-telemetry.types';
import type { GuardrailTurnTrace } from '@shared-types/guardrail.contract';
import type { TurnOutcome } from '@agent/runner/agent-runner.types';

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
  /**
   * 出站守卫拦截（reply 命中 ReplyFactGuard 阻断规则，如歧视性筛选条件外露）：
   * reply.content 保留供观测留痕，但**不得**发送给候选人。
   */
  blockedByGuard?: {
    ruleIds: string[];
    /** 出站守卫降级/严重违规时的归因码（非 rule 命中时使用，如 output_review_unavailable）。 */
    reasonCode?: string;
    /** 是否由确定性 rule 档拦截（rule 档命中已在守卫内发飞书告警；非 rule 档需另行转人工）。 */
    ruleBlocked?: boolean;
  };
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
   * reply→可投递，skipped/blocked/handoff→不投递。投递/沉默分支据此判定，与 runner 主动链路同源。
   */
  outcome?: TurnOutcome;
  /**
   * 调用方延迟触发 turn-end 生命周期的开关（仅在启用 replay 时暴露）。
   * 采纳本次结果 → 必须 await 一次；被 replay 丢弃 → 忽略即可。
   * `includeAssistantText=false`（默认 true）：回复未真实送达时只记用户侧记忆，不投影助手轮次。
   */
  runTurnEnd?: (opts?: { includeAssistantText?: boolean }) => Promise<void>;
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

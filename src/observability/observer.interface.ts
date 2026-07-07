/**
 * Agent 事件观测接口（对标 ZeroClaw Observer）。
 *
 * 这里的事件不是普通应用日志，而是一次 Agent 执行过程可查询、可下钻的结构化事实。
 * traceId 与 message_processing_records.message_id 同源，用于把消息主账本、执行事件、
 * 守卫审查档案串成同一条处理链。
 */

export interface AgentEventContext {
  traceId?: string;
  chatId?: string;
  userId?: string;
  corpId?: string;
  scenario?: string;
  callerKind?: string;
  timestamp?: number;
}

export type AgentEvent = AgentEventContext &
  (
    | { type: 'agent_start'; userId?: string; corpId?: string; scenario?: string }
    | {
        type: 'agent_end';
        userId?: string;
        steps?: number;
        totalTokens?: number;
        durationMs: number;
      }
    | { type: 'agent_error'; userId?: string; error: string }
    | {
        type: 'agent_stream_timing';
        messageId: string;
        sessionId: string;
        userId?: string;
        scenario?: string;
        status: 'success' | 'failure';
        timeToStreamReadyMs?: number;
        timeToFirstChunkMs?: number;
        timeToFirstReasoningMs?: number;
        timeToFirstTextMs?: number;
        streamDurationMs?: number;
        totalDurationMs: number;
        totalTokens?: number;
        error?: string;
      }
    | { type: 'model_call'; modelId: string; role: string }
    | { type: 'model_fallback'; fromModel: string; toModel: string; reason: string }
    | {
        type: 'tool_call';
        toolName: string;
        userId?: string;
        durationMs?: number;
        status?: string;
        resultCount?: number;
        sideEffect?: boolean;
      }
    | { type: 'tool_error'; toolName: string; error: string; durationMs?: number }
    | { type: 'memory_recall'; userId: string; found: boolean }
    | { type: 'memory_store'; userId: string; keys: string[] }
  );

export interface Observer {
  emit(event: AgentEvent): void;
}

export const OBSERVER = Symbol('OBSERVER');

/**
 * Agent 事件观测接口（对标 ZeroClaw Observer）
 */

export type AgentEvent =
  | { type: 'agent_start'; userId: string; corpId: string; scenario: string }
  | { type: 'agent_end'; userId: string; steps: number; totalTokens: number; durationMs: number }
  | { type: 'agent_error'; userId: string; error: string }
  | { type: 'model_call'; modelId: string; role: string }
  | { type: 'model_fallback'; fromModel: string; toModel: string; reason: string }
  | { type: 'tool_call'; toolName: string; userId: string }
  | { type: 'tool_error'; toolName: string; error: string }
  | { type: 'memory_recall'; userId: string; found: boolean }
  | { type: 'memory_store'; userId: string; keys: string[] };

export interface Observer {
  emit(event: AgentEvent): void;
}

export const OBSERVER = Symbol('OBSERVER');

import type { ToolReplayEvidence } from './tool-replay.types';

/** Agent 失败链路上传播的结构化诊断信息。 */
export interface AgentErrorMeta {
  /** Prevent any whole-turn fallback from replaying external actions. */
  replayBlockedBy?: ToolReplayEvidence[];
  modelsAttempted?: string[];
  totalAttempts?: number;
  lastCategory?: string;
  sessionId?: string;
  userId?: string;
  messageCount?: number;
  memoryLoadWarning?: string;
}

/** 统一的 Agent 错误扩展字段。 */
export type AgentError = Error & {
  isAgentError?: boolean;
  agentMeta?: AgentErrorMeta;
  apiKey?: string;
};

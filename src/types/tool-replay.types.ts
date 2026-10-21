/** Minimal replay evidence: no tool input, credentials, candidate data or raw response. */
export type ToolReplayStatus =
  | 'pending'
  | 'executing'
  | 'unknown'
  | 'succeeded'
  | 'blocked'
  | 'cancelled';
export interface ToolReplayEvidence {
  toolName: string;
  toolCallId?: string;
  status: ToolReplayStatus;
  component?: string;
}

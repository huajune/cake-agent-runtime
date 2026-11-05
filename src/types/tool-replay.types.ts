import { ACTION_EXECUTION_STATUS, ACTION_STATE } from './action-execution.contract';

/** Pending is an in-process fence, not a persisted journal state. */
export const TOOL_REPLAY_STATUS = {
  PENDING: 'pending',
  EXECUTING: ACTION_STATE.EXECUTING,
  UNKNOWN: ACTION_STATE.UNKNOWN,
  SUCCEEDED: ACTION_STATE.SUCCEEDED,
  BLOCKED: ACTION_EXECUTION_STATUS.BLOCKED,
  CANCELLED: ACTION_STATE.CANCELLED,
} as const;
export type ToolReplayStatus = (typeof TOOL_REPLAY_STATUS)[keyof typeof TOOL_REPLAY_STATUS];

/** Uncertainty takes precedence over success when one tool returns multiple action receipts. */
export const TOOL_REPLAY_PRECEDENCE: readonly ToolReplayStatus[] = [
  TOOL_REPLAY_STATUS.UNKNOWN,
  TOOL_REPLAY_STATUS.EXECUTING,
  TOOL_REPLAY_STATUS.PENDING,
  TOOL_REPLAY_STATUS.BLOCKED,
  TOOL_REPLAY_STATUS.CANCELLED,
  TOOL_REPLAY_STATUS.SUCCEEDED,
];

export const RECEIPT_ACTION_STATUS = {
  ...TOOL_REPLAY_STATUS,
  FAILED: ACTION_STATE.FAILED,
} as const;
export type ReceiptActionStatus =
  (typeof RECEIPT_ACTION_STATUS)[keyof typeof RECEIPT_ACTION_STATUS];

/** Minimal replay evidence: no tool input, credentials, candidate data or raw response. */
export interface ToolReplayEvidence {
  toolName: string;
  toolCallId?: string;
  status: ToolReplayStatus;
  component?: string;
}

/** These receipts forbid automatic retry and still require result verification. */
export const UNRESOLVED_TOOL_REPLAY_STATUSES: ReadonlySet<ToolReplayStatus> = new Set([
  TOOL_REPLAY_STATUS.UNKNOWN,
  TOOL_REPLAY_STATUS.EXECUTING,
  TOOL_REPLAY_STATUS.PENDING,
]);

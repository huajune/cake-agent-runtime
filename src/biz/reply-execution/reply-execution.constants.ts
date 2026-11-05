export const REPLY_TURN_STATUS = {
  PREPARING: 'preparing',
  PLANNED: 'planned',
  SETTLED: 'settled',
  ACKED: 'acked',
} as const;
export type ReplyTurnStatus = (typeof REPLY_TURN_STATUS)[keyof typeof REPLY_TURN_STATUS];

export const REPLY_PROJECTION_STATUS = {
  NONE: 'none',
  PENDING: 'pending',
  COMPLETE: 'complete',
} as const;
export type ReplyProjectionStatus =
  (typeof REPLY_PROJECTION_STATUS)[keyof typeof REPLY_PROJECTION_STATUS];

export const REPLY_TURN_OPERATION = {
  OPEN: 'open',
  PLAN: 'plan',
  SETTLE: 'settle',
  ACK: 'ack',
  DEFER: 'defer',
  PROJECT: 'project',
  DEFER_PROJECTION: 'defer_projection',
} as const;
export type ReplyTurnOperation = (typeof REPLY_TURN_OPERATION)[keyof typeof REPLY_TURN_OPERATION];

export const REPLY_RECOVERY_TASK = { REENGAGEMENT: 'reengagement' } as const;

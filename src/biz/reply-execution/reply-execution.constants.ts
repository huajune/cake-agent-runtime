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

export const REPLY_REVIEW_REASON = {
  BUSINESS_EFFECTS_UNCONFIRMED: 'business_effects_unconfirmed',
} as const;

export const REPLY_TURN_OPERATION = {
  OPEN: 'open',
  PLAN: 'plan',
  START_DELIVERY: 'start_delivery',
  SAVE_EFFECTS: 'save_effects',
  CHECK_DELIVERY: 'check_delivery',
  CHECK_INPUT: 'check_input',
  INTERRUPT: 'interrupt',
  SETTLE: 'settle',
  ACK: 'ack',
  DEFER: 'defer',
  PROJECT: 'project',
} as const;
export type ReplyTurnOperation = (typeof REPLY_TURN_OPERATION)[keyof typeof REPLY_TURN_OPERATION];

/** Frozen is retained only for inbound obligations created by older versions. */
export const REPLY_DELIVERY_POLICY = {
  FROZEN: 'frozen',
  SINGLE_PASS: 'single_pass',
} as const;
export type ReplyDeliveryPolicy =
  (typeof REPLY_DELIVERY_POLICY)[keyof typeof REPLY_DELIVERY_POLICY];

export const REPLY_DELIVERY_OUTCOME = {
  COMPLETE: 'complete',
  INCOMPLETE: 'incomplete',
  UNKNOWN: 'unknown',
  SKIPPED: 'skipped',
  INTERRUPTED: 'interrupted',
} as const;
export type ReplyDeliveryOutcome =
  (typeof REPLY_DELIVERY_OUTCOME)[keyof typeof REPLY_DELIVERY_OUTCOME];

export function isReplyDeliveryPolicy(value: unknown): value is ReplyDeliveryPolicy {
  return Object.values(REPLY_DELIVERY_POLICY).some((policy) => value === policy);
}

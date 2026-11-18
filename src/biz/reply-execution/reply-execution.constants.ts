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
  INTERRUPTED: 'ordinary_reply_interrupted_no_resend',
  PROVIDER_OUTAGE: 'model_unavailable_before_tools',
  RECOVERY_DEADLINE: 'recovery_deadline',
} as const;

export type ReplyReviewReason = (typeof REPLY_REVIEW_REASON)[keyof typeof REPLY_REVIEW_REASON];

export const REPLY_TURN_OPERATION = {
  OPEN: 'open',
  START_DELIVERY: 'start_delivery',
  SAVE_EFFECTS: 'save_effects',
  SAVE_LATE_EFFECTS: 'save_late_effects',
  CHECK_DELIVERY: 'check_delivery',
  CHECK_INPUT: 'check_input',
  RENEW: 'renew',
  RECORD_FAILURE: 'record_failure',
  CLOSE_MODEL_OUTAGE: 'close_model_outage',
  REQUEST_REVIEW: 'request_review',
  REVIEW_NOTIFIED: 'review_notified',
  INTERRUPT: 'interrupt',
  SETTLE: 'settle',
  ACK: 'ack',
  DEFER: 'defer',
  PROJECT: 'project',
} as const;
export type ReplyTurnOperation = (typeof REPLY_TURN_OPERATION)[keyof typeof REPLY_TURN_OPERATION];

/** Persisted wire value shared with the supported rollback application. */
export const REPLY_DELIVERY_POLICY = {
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

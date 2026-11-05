/** Stored Redis outbox states, independent of action journal and provider delivery states. */
export const TOUCH_SLOT_STATE = {
  RESERVED: 'reserved',
  DELIVERY_ATTEMPTED: 'delivery_attempted',
  SENT: 'sent',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
} as const;
export type TouchSlotState = (typeof TOUCH_SLOT_STATE)[keyof typeof TOUCH_SLOT_STATE];

export const TOUCH_RESERVE_RESULT = {
  RESERVED: TOUCH_SLOT_STATE.RESERVED,
  DUPLICATE_SENT: 'duplicate_sent',
  DUPLICATE_INFLIGHT: 'duplicate_inflight',
} as const;
export type ReserveResult = (typeof TOUCH_RESERVE_RESULT)[keyof typeof TOUCH_RESERVE_RESULT];

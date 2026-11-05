/** Stable wire values shared by the journal, channels, tools and retry readers. */
export const ACTION_MODE = { OFF: 'off', OBSERVE: 'observe', EXECUTE: 'execute' } as const;
export type ActionMode = (typeof ACTION_MODE)[keyof typeof ACTION_MODE];

export function isActionMode(value: unknown): value is ActionMode {
  return typeof value === 'string' && Object.values<string>(ACTION_MODE).includes(value);
}

/** Persisted action states. A blocked dispatch is not a journal state. */
export const ACTION_STATE = {
  REGISTERED: 'registered',
  EXECUTING: 'executing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  UNKNOWN: 'unknown',
  CANCELLED: 'cancelled',
} as const;
export type ActionState = (typeof ACTION_STATE)[keyof typeof ACTION_STATE];

export const ACTION_EXECUTION_STATUS = { ...ACTION_STATE, BLOCKED: 'blocked' } as const;
export type ActionExecutionStatus =
  (typeof ACTION_EXECUTION_STATUS)[keyof typeof ACTION_EXECUTION_STATUS];

export const LOCAL_SYNC_STATE = { PENDING: 'pending', COMPLETE: 'complete' } as const;
export type LocalSyncState = (typeof LOCAL_SYNC_STATE)[keyof typeof LOCAL_SYNC_STATE];

export const ACTION_EVIDENCE_KIND = {
  COMPLETED: 'completed',
  ACCEPTED: 'accepted',
  ALREADY_SATISFIED: 'already_satisfied',
  DEFINITIVE_NO_EFFECT: 'definitive_no_effect',
  INDETERMINATE: 'indeterminate',
} as const;
export type ActionEvidenceKind = (typeof ACTION_EVIDENCE_KIND)[keyof typeof ACTION_EVIDENCE_KIND];

/** Built-in handlers. The registry also accepts separately registered extension kinds. */
export const ACTION_KIND = {
  SPONGE_BOOKING: 'sponge.booking',
  SPONGE_CANCEL: 'sponge.cancel',
  SPONGE_MODIFY: 'sponge.modify',
  MESSAGE_LOCATION: 'message.location',
  MESSAGE_INTERVIEW_ADDRESS: 'message.interview_address',
  WECOM_GROUP_ADD_MEMBER: 'wecom.group_add_member',
  WECOM_REPLY_SEGMENT: 'wecom.reply_segment',
  GROUP_TASK_MESSAGE: 'group_task.message',
  BOOKING_NOTIFICATION: 'booking_notification',
  CANCELLATION_NOTIFICATION: 'cancellation_notification',
} as const;
export type BuiltInActionKind = (typeof ACTION_KIND)[keyof typeof ACTION_KIND];

/** The Sponge write adapter accepts only its three supported operation kinds. */
export type SpongeActionKind =
  | typeof ACTION_KIND.SPONGE_BOOKING
  | typeof ACTION_KIND.SPONGE_CANCEL
  | typeof ACTION_KIND.SPONGE_MODIFY;

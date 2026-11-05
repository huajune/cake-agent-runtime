/** Operations accepted by transition_agent_action; values are part of the SQL protocol. */
export const ACTION_RECORD_OPERATION = {
  PREPARE: 'prepare',
  CLAIM: 'claim',
  RECONCILE_CLAIM: 'reconcile_claim',
  SETTLE: 'settle',
  VALIDATE_CLAIM: 'validate_claim',
  SYNCED: 'synced',
  CANCEL: 'cancel',
  SCHEDULE: 'schedule',
  MANUAL: 'manual',
} as const;
export type ActionRecordOperation =
  (typeof ACTION_RECORD_OPERATION)[keyof typeof ACTION_RECORD_OPERATION];

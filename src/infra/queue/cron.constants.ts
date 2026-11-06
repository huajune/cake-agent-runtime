/** Stable lease/lifecycle identities; values are also persisted in Redis. */
export const CRON_JOB = {
  OPS_DAILY_REPORT: 'ops-daily-report',
  SPONGE_STATUS_POLL: 'sponge-status-poll',
  CHAT_RECORD_SYNC: 'chat-record-sync',
  GROUP_ORDER_MORNING: 'group-order-morning',
  GROUP_ORDER_AFTERNOON: 'group-order-afternoon',
  GROUP_ORDER_EVENING: 'group-order-evening',
  GROUP_PART_TIME: 'group-part-time',
  GROUP_STORE_MANAGER: 'group-store-manager',
  GROUP_WORK_TIPS: 'group-work-tips',
  ACTION_RETENTION: 'action-retention',
  REPLY_RETENTION: 'reply-retention',
} as const;
export type CronJob = (typeof CRON_JOB)[keyof typeof CRON_JOB];

export const CRON_RUN_STATE = {
  STARTED: 'started',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export type CronRunState = (typeof CRON_RUN_STATE)[keyof typeof CRON_RUN_STATE];

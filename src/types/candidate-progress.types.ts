export const PROGRESS_TRUTH = { YES: 'yes', NO: 'no', UNKNOWN: 'unknown' } as const;
export type ProgressTruth = (typeof PROGRESS_TRUTH)[keyof typeof PROGRESS_TRUTH];
export const PROGRESS_READ_MODE = { FRESH: 'fresh', CACHED: 'cached' } as const;
export type ProgressReadMode = (typeof PROGRESS_READ_MODE)[keyof typeof PROGRESS_READ_MODE];
export const PROGRESS_POLICY = { LEGACY: 'legacy' } as const;
export const PROGRESS_PHONE_SOURCE = {
  SESSION: 'session',
  PROFILE: 'profile',
  MISSING: 'missing',
} as const;
export type ProgressPhoneSource =
  (typeof PROGRESS_PHONE_SOURCE)[keyof typeof PROGRESS_PHONE_SOURCE];
export const PROGRESS_ORDER_SOURCE = {
  SPONGE_CROSS_ACCOUNT: 'sponge_cross_account',
  SNAPSHOT: 'snapshot',
} as const;
export type ProgressOrderSource =
  (typeof PROGRESS_ORDER_SOURCE)[keyof typeof PROGRESS_ORDER_SOURCE];
export const PROGRESS_READER = { CONTEXT: 'context', PRE_BOOKING: 'pre_booking' } as const;
export type ProgressReader = (typeof PROGRESS_READER)[keyof typeof PROGRESS_READER];

export const BOOKING_DUPLICATE_MATCH = { JOB: 'job', BRAND: 'brand' } as const;
export type BookingDuplicateMatch =
  (typeof BOOKING_DUPLICATE_MATCH)[keyof typeof BOOKING_DUPLICATE_MATCH];

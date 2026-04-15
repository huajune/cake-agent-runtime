export const RECRUITMENT_CASE_TYPES = ['onboard_followup'] as const;
export type RecruitmentCaseType = (typeof RECRUITMENT_CASE_TYPES)[number];

export const RECRUITMENT_CASE_STATUSES = [
  'active',
  'handoff',
  'closed',
  'expired',
] as const;
export type RecruitmentCaseStatus = (typeof RECRUITMENT_CASE_STATUSES)[number];

export interface RecruitmentCaseSnapshot {
  bookingId?: string | null;
  bookedAt?: string | null;
  interviewTime?: string | null;
  jobId?: number | null;
  jobName?: string | null;
  brandName?: string | null;
  storeName?: string | null;
  botImId?: string | null;
  followupWindowEndsAt?: string | null;
  metadata?: Record<string, unknown> | null;
}


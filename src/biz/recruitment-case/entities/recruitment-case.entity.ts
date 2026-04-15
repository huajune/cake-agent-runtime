import type { RecruitmentCaseStatus, RecruitmentCaseType } from '../types/recruitment-case.types';

/**
 * 招聘流程 Case
 * @table recruitment_cases
 */
export interface RecruitmentCaseRecord {
  id: string;
  corp_id: string;
  chat_id: string;
  user_id: string | null;
  case_type: RecruitmentCaseType;
  status: RecruitmentCaseStatus;
  booking_id: string | null;
  booked_at: string | null;
  interview_time: string | null;
  job_id: number | null;
  job_name: string | null;
  brand_name: string | null;
  store_name: string | null;
  bot_im_id: string | null;
  followup_window_ends_at: string | null;
  last_relevant_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

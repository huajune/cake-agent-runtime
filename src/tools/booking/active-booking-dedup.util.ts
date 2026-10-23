import type { ActiveBookingEntry } from '@memory/long-term/long-term.types';

export {
  BOOKING_DEDUP_WINDOW_MS,
  isRecentSameJobBooking,
  findRecentSameJobBooking,
} from '@biz/candidate-progress/policies/legacy-progress.policies';

/**
 * 面试日期（`YYYY-MM-DD` 前缀）是否早于今天。无日期（等通知单）或无法识别时按未过处理。
 * 已过面试日的预约归 [当前预约信息] 的"先核实是否到场"口径，不再作为需要保护的在途预约。
 */
export function isInterviewDayPassed(
  interviewTime: string | null | undefined,
  today: string,
): boolean {
  const date = interviewTime?.trim().match(/^\d{4}-\d{2}-\d{2}/u)?.[0];
  return date !== undefined && date < today;
}

/**
 * 候选人名下同岗位的在途预约（active_booking 指针），**不带查重时间窗**。
 *
 * 与 findRecentSameJobBooking 回答的问题不同：后者只判断"30 分钟内是否刚建过单"（查重），
 * 这里判断"这个岗位上的预约是否仍在"——岗位详情查不到不等于已约面试失效。
 * job_id 必须精确相等：存量空 job_id 行不能证明预约属于本岗。面试日已过的不算。
 */
export function findActiveBookingForJob(
  entries: readonly ActiveBookingEntry[],
  jobId: number,
  today: string,
): ActiveBookingEntry | undefined {
  return entries.find(
    (entry) => entry.job_id === jobId && !isInterviewDayPassed(entry.interview_time, today),
  );
}

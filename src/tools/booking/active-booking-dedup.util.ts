import type { ActiveBookingEntry } from '@memory/long-term/long-term.types';

/**
 * 同岗位在途工单查重窗口。
 *
 * active_booking 是候选人级（corpId + userId）指针，跨托管账号共享：同一候选人同时跟两个
 * 账号聊、另一账号刚建单时，本账号也会命中。booking 与 precheck 必须用**同一条**判据——
 * precheck 先于 booking 亮出在途工单，模型才有机会如实说"已约上"而不是提交后被查重打回。
 */
export const BOOKING_DEDUP_WINDOW_MS = 30 * 60 * 1000;

/**
 * 是否为查重窗口内的同岗位在途工单。`job_id` 为空的存量行按命中处理——老行没记岗位，
 * 宁可让模型核对一张真实工单，也不放行一次重复报名。
 */
export function isRecentSameJobBooking(
  entry: ActiveBookingEntry,
  jobId: number,
  now: number = Date.now(),
): boolean {
  const linkedAt = Date.parse(entry.linked_at);
  return (
    Number.isFinite(linkedAt) &&
    now - linkedAt < BOOKING_DEDUP_WINDOW_MS &&
    (entry.job_id == null || entry.job_id === jobId)
  );
}

/** 列表按 linked_at 倒序（getActiveBookings 契约），首个命中即最近一笔。 */
export function findRecentSameJobBooking(
  entries: readonly ActiveBookingEntry[],
  jobId: number,
  now: number = Date.now(),
): ActiveBookingEntry | undefined {
  return entries.find((entry) => isRecentSameJobBooking(entry, jobId, now));
}

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

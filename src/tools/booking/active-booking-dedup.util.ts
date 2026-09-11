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

import {
  BOOKING_DEDUP_WINDOW_MS,
  findRecentSameJobBooking,
  isRecentSameJobBooking,
} from '@tools/booking/active-booking-dedup.util';

const NOW = Date.parse('2026-09-11T07:19:59.000Z');
const at = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();

describe('active-booking-dedup.util（booking 与 precheck 共用的同岗位查重判据）', () => {
  it('查重窗口是 30 分钟', () => {
    expect(BOOKING_DEDUP_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it('窗口内同岗位命中；窗口边界（恰好 30 分钟）不命中', () => {
    expect(
      isRecentSameJobBooking(
        { work_order_id: 1, job_id: 528902, linked_at: at(47_000) },
        528902,
        NOW,
      ),
    ).toBe(true);
    expect(
      isRecentSameJobBooking(
        { work_order_id: 1, job_id: 528902, linked_at: at(BOOKING_DEDUP_WINDOW_MS - 1) },
        528902,
        NOW,
      ),
    ).toBe(true);
    expect(
      isRecentSameJobBooking(
        { work_order_id: 1, job_id: 528902, linked_at: at(BOOKING_DEDUP_WINDOW_MS) },
        528902,
        NOW,
      ),
    ).toBe(false);
  });

  it('不同岗位不命中；job_id 为空的存量行按命中处理', () => {
    expect(
      isRecentSameJobBooking({ work_order_id: 1, job_id: 1, linked_at: at(1_000) }, 2, NOW),
    ).toBe(false);
    expect(
      isRecentSameJobBooking({ work_order_id: 1, job_id: null, linked_at: at(1_000) }, 2, NOW),
    ).toBe(true);
    expect(isRecentSameJobBooking({ work_order_id: 1, linked_at: at(1_000) }, 2, NOW)).toBe(true);
  });

  it('linked_at 不可解析不命中', () => {
    expect(
      isRecentSameJobBooking({ work_order_id: 1, job_id: 2, linked_at: 'not-a-date' }, 2, NOW),
    ).toBe(false);
  });

  it('findRecentSameJobBooking 取列表中首个命中（列表按 linked_at 倒序，即最近一笔）', () => {
    const entries = [
      { work_order_id: 464336, job_id: 528902, linked_at: at(47_000) },
      { work_order_id: 400000, job_id: 528902, linked_at: at(60 * 60 * 1000) },
      { work_order_id: 300000, job_id: 1, linked_at: at(1_000) },
    ];
    expect(findRecentSameJobBooking(entries, 528902, NOW)?.work_order_id).toBe(464336);
    expect(findRecentSameJobBooking(entries, 999, NOW)).toBeUndefined();
    expect(findRecentSameJobBooking([], 528902, NOW)).toBeUndefined();
  });
});

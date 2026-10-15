import {
  BOOKING_DEDUP_WINDOW_MS,
  findActiveBookingForJob,
  findRecentSameJobBooking,
  isInterviewDayPassed,
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

describe('findActiveBookingForJob（岗位查不到时的预约保护，不带查重时间窗）', () => {
  const today = '2026-09-24';

  it('建单早于 30 分钟查重窗的同岗位指针仍命中', () => {
    const entry = {
      work_order_id: 467501,
      job_id: 529389,
      linked_at: at(6 * 60 * 60 * 1000),
      interview_time: '2026-09-24 13:30:00',
    };
    expect(findRecentSameJobBooking([entry], 529389, NOW)).toBeUndefined();
    expect(findActiveBookingForJob([entry], 529389, today)).toBe(entry);
  });

  it('只认精确 job_id；存量空 job_id 行与别岗工单不算', () => {
    expect(
      findActiveBookingForJob(
        [
          { work_order_id: 1, job_id: null, linked_at: at(1000) },
          { work_order_id: 2, job_id: 111, linked_at: at(1000) },
        ],
        529389,
        today,
      ),
    ).toBeUndefined();
  });

  it('面试日已过的不算；等通知单（无面试时间）算在途', () => {
    expect(
      findActiveBookingForJob(
        [
          {
            work_order_id: 1,
            job_id: 529389,
            linked_at: at(1000),
            interview_time: '2026-09-23 13:30:00',
          },
        ],
        529389,
        today,
      ),
    ).toBeUndefined();
    expect(
      findActiveBookingForJob(
        [{ work_order_id: 2, job_id: 529389, linked_at: at(1000) }],
        529389,
        today,
      )?.work_order_id,
    ).toBe(2);
  });

  it('isInterviewDayPassed 只比较日期前缀，无法识别时按未过', () => {
    expect(isInterviewDayPassed('2026-09-23 23:59', today)).toBe(true);
    expect(isInterviewDayPassed('2026-09-24 08:00:00', today)).toBe(false);
    expect(isInterviewDayPassed(null, today)).toBe(false);
    expect(isInterviewDayPassed('待定', today)).toBe(false);
  });
});

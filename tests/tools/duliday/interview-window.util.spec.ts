import {
  compareTime,
  findSameDayCutoffViolation,
  getShanghaiWeekday,
  isDateOnlyWindow,
  normalizeDateTime,
  normalizeHm,
  parseCycleDeadlineDay,
  resolveBookingDeadlineDateTime,
  shiftDate,
} from '@tools/duliday/interview-window.util';
import type { InterviewWindow } from '@tools/duliday/job-policy-parser';

describe('interview-window.util', () => {
  it('should normalize HH:mm strings to two-digit hour format', () => {
    expect(normalizeHm('9:30')).toBe('09:30');
    expect(normalizeHm('09：05')).toBe('09:05');
    expect(normalizeHm('24:00')).toBeNull();
    expect(normalizeHm('上午九点')).toBeNull();
  });

  it('should compare normalized times lexicographically', () => {
    expect(compareTime('09:30', '10:00')).toBeLessThan(0);
    expect(compareTime('16:00', '10:00')).toBeGreaterThan(0);
  });

  it('should shift dates without local timezone drift', () => {
    expect(shiftDate('2026-04-30', 1)).toBe('2026-05-01');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('should resolve Shanghai weekday labels', () => {
    expect(getShanghaiWeekday('2026-04-30')).toBe('每周四');
    expect(getShanghaiWeekday('2026-05-03')).toBe('每周日');
  });

  it('should parse cycle deadline day values', () => {
    expect(parseCycleDeadlineDay('当天')).toBe(0);
    expect(parseCycleDeadlineDay('前一天')).toBe(-1);
    expect(parseCycleDeadlineDay('前2天')).toBe(-2);
    expect(parseCycleDeadlineDay('3')).toBe(3);
    expect(parseCycleDeadlineDay('提前')).toBeNull();
  });

  it('should normalize deadline date-time values', () => {
    expect(normalizeDateTime('2026/04/30 9:30:00')).toBe('2026-04-30 09:30');
    expect(normalizeDateTime('2026-04-30 18:05')).toBe('2026-04-30 18:05');
    expect(normalizeDateTime('4月30日 9:30')).toBeNull();
  });

  it('should resolve fixed and cycle booking deadlines', () => {
    const fixedWindow: InterviewWindow = {
      date: '2026-04-30',
      startTime: '9:30',
      endTime: '10:30',
      fixedDeadline: '2026/04/29 18:00',
    };
    const cycleWindow: InterviewWindow = {
      weekday: '每周四',
      startTime: '9:30',
      endTime: '10:30',
      cycleDeadlineDay: '前一天',
      cycleDeadlineEnd: '18:00',
    };

    expect(resolveBookingDeadlineDateTime('2026-04-30', fixedWindow)).toBe('2026-04-29 18:00');
    expect(resolveBookingDeadlineDateTime('2026-04-30', cycleWindow)).toBe('2026-04-29 18:00');
  });

  it('should detect date-only interview windows', () => {
    expect(isDateOnlyWindow({ weekday: '每周四', startTime: '00:00', endTime: '00:00' })).toBe(
      true,
    );
    expect(isDateOnlyWindow({ weekday: '每周四', startTime: '9:30', endTime: '10:30' })).toBe(
      false,
    );
  });

  describe('findSameDayCutoffViolation', () => {
    // 上海时间 2026-04-29 14:00（周三）→ 已过当日 12:00 截止
    const NOW_AFTER_CUTOFF = new Date('2026-04-29T06:00:00.000Z');
    // 上海时间 2026-04-29 10:00（周三）→ 未到当日 12:00 截止
    const NOW_BEFORE_CUTOFF = new Date('2026-04-29T02:00:00.000Z');

    const window: InterviewWindow = {
      weekday: '每周三',
      startTime: '13:30',
      endTime: '17:00',
      cycleDeadlineDay: '当天',
      cycleDeadlineEnd: '12:00',
    };

    it('blocks when interviewDate=today and current time has passed all deadlines', () => {
      const result = findSameDayCutoffViolation('2026-04-29', [window], NOW_AFTER_CUTOFF);
      expect(result).not.toBeNull();
      expect(result?.latestDeadline).toBe('2026-04-29 12:00');
      expect(result?.reason).toContain('已超过');
    });

    it('does not block when current time is still before deadline', () => {
      expect(
        findSameDayCutoffViolation('2026-04-29', [window], NOW_BEFORE_CUTOFF),
      ).toBeNull();
    });

    it('does not block when interviewDate is in the future', () => {
      expect(
        findSameDayCutoffViolation('2026-04-30', [window], NOW_AFTER_CUTOFF),
      ).toBeNull();
    });

    it('returns null when no matching window for the date', () => {
      const thursdayWindow: InterviewWindow = { ...window, weekday: '每周四' };
      expect(
        findSameDayCutoffViolation('2026-04-29', [thursdayWindow], NOW_AFTER_CUTOFF),
      ).toBeNull();
    });

    it('returns null when window has no deadline configured', () => {
      const noDeadline: InterviewWindow = {
        weekday: '每周三',
        startTime: '13:30',
        endTime: '17:00',
      };
      expect(
        findSameDayCutoffViolation('2026-04-29', [noDeadline], NOW_AFTER_CUTOFF),
      ).toBeNull();
    });

    it('handles fixed-date windows', () => {
      const fixed: InterviewWindow = {
        date: '2026-04-29',
        startTime: '13:30',
        endTime: '17:00',
        fixedDeadline: '12:00',
      };
      const result = findSameDayCutoffViolation('2026-04-29', [fixed], NOW_AFTER_CUTOFF);
      expect(result).not.toBeNull();
      expect(result?.latestDeadline).toBe('2026-04-29 12:00');
    });
  });
});

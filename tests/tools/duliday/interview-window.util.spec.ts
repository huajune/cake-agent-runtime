import {
  compareTime,
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
});

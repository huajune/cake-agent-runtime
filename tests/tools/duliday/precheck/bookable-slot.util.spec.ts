import {
  buildBookableSlots,
  buildScheduleRule,
  buildUpcomingTimeOptions,
  evaluateRequestedDate,
} from '@tools/duliday/precheck/bookable-slot.util';
import type { InterviewWindow } from '@tools/utils/job-policy-parser';

/** Shanghai 2026-05-19 周二 09:00（早于绝大多数面试窗口，保证 slot 不被报名截止过滤掉）。 */
const FIXED_NOW = new Date('2026-05-19T09:00:00+08:00');

describe('bookable-slot.util', () => {
  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(FIXED_NOW);
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  describe('buildUpcomingTimeOptions', () => {
    it('returns [] for empty windows', () => {
      expect(buildUpcomingTimeOptions([])).toEqual([]);
    });

    it('expands weekday windows over horizonDays and tags 今日', () => {
      const windows: InterviewWindow[] = [
        { weekday: '每周二', startTime: '13:30', endTime: '16:30' },
        { weekday: '每周三', startTime: '13:30', endTime: '16:30' },
      ];
      const out = buildUpcomingTimeOptions(windows, 7, 10);
      expect(out.length).toBeGreaterThan(0);
      // 2026-05-19 周二 09:00 → 当天 13:30 还没到，应包含今日 label
      expect(out.some((label) => label.includes('2026-05-19') && label.includes('今日'))).toBe(
        true,
      );
      // 2026-05-20 周三 也应该出现
      expect(out.some((label) => label.includes('2026-05-20'))).toBe(true);
    });

    it('respects maxOptions cap', () => {
      const windows: InterviewWindow[] = [
        { weekday: '每周一', startTime: '09:00', endTime: '11:00' },
        { weekday: '每周二', startTime: '13:30', endTime: '16:30' },
        { weekday: '每周三', startTime: '13:30', endTime: '16:30' },
        { weekday: '每周四', startTime: '13:30', endTime: '16:30' },
        { weekday: '每周五', startTime: '13:30', endTime: '16:30' },
      ];
      const out = buildUpcomingTimeOptions(windows, 7, 3);
      expect(out.length).toBeLessThanOrEqual(3);
    });

    it('filters past-deadline windows', () => {
      const windows: InterviewWindow[] = [
        // fixedDeadline 早于 FIXED_NOW → 不应出现
        {
          weekday: '每周二',
          startTime: '13:30',
          endTime: '16:30',
          fixedDeadline: '2026-05-19 08:00',
        },
      ];
      expect(buildUpcomingTimeOptions(windows)).toEqual([]);
    });
  });

  describe('buildBookableSlots', () => {
    it('marks normal weekday windows as bookingAllowed', () => {
      const windows: InterviewWindow[] = [
        { weekday: '每周三', startTime: '13:30', endTime: '16:30' },
      ];
      const slots = buildBookableSlots({ windows });
      const tomorrow = slots.find((s) => s.date === '2026-05-20');
      expect(tomorrow).toBeDefined();
      expect(tomorrow?.bookingAllowed).toBe(true);
      expect(typeof tomorrow?.interviewTime).toBe('string');
      expect(tomorrow?.interviewTime as string).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/);
    });

    it('marks date-only windows as requiresManualConfirmation', () => {
      // 业务侧 isDateOnlyWindow 判定：startTime / endTime 都归一为 00:00 视为"只有日期"。
      const windows: InterviewWindow[] = [
        { date: '2026-05-22', startTime: '00:00', endTime: '00:00' },
      ];
      const slots = buildBookableSlots({ windows });
      const target = slots.find((s) => s.date === '2026-05-22');
      expect(target).toBeDefined();
      expect(target?.bookingAllowed).toBe(false);
      expect(target?.requiresManualConfirmation).toBe(true);
      expect(target?.dateOnly).toBe(true);
      expect(target?.reason).toContain('没有明确几点');
    });

    it('marks unparseable startTime windows as requiresManualConfirmation', () => {
      const windows: InterviewWindow[] = [
        { weekday: '每周三', startTime: 'unknown', endTime: '16:30' },
      ];
      const slots = buildBookableSlots({ windows });
      const target = slots.find((s) => s.date === '2026-05-20');
      expect(target?.bookingAllowed).toBe(false);
      expect(target?.requiresManualConfirmation).toBe(true);
    });

    it('elevates requestedDate slots to the front of the result list', () => {
      const windows: InterviewWindow[] = [
        { weekday: '每周三', startTime: '13:30', endTime: '16:30' },
        { weekday: '每周四', startTime: '13:30', endTime: '16:30' },
      ];
      const slots = buildBookableSlots({ windows, requestedDate: '2026-05-21' });
      expect(slots[0]?.date).toBe('2026-05-21');
    });

    it('returns [] for empty windows', () => {
      expect(buildBookableSlots({ windows: [] })).toEqual([]);
    });
  });

  describe('buildScheduleRule', () => {
    it('returns "" when there are no periodic windows', () => {
      expect(buildScheduleRule([])).toBe('');
      expect(
        buildScheduleRule([{ date: '2026-05-22', startTime: '10:00', endTime: '11:00' }]),
      ).toBe('');
    });

    it('compresses 3+ consecutive weekdays as "周X至周Y"', () => {
      const result = buildScheduleRule([
        { weekday: '每周一', startTime: '13:30', endTime: '16:30' },
        { weekday: '每周二', startTime: '13:30', endTime: '16:30' },
        { weekday: '每周三', startTime: '13:30', endTime: '16:30' },
        { weekday: '每周四', startTime: '13:30', endTime: '16:30' },
        { weekday: '每周五', startTime: '13:30', endTime: '16:30' },
      ]);
      expect(result).toContain('周一至周五');
      expect(result).toContain('13:30-16:30');
    });

    it('lists non-consecutive weekdays with、separator', () => {
      const result = buildScheduleRule([
        { weekday: '每周一', startTime: '10:00', endTime: '12:00' },
        { weekday: '每周三', startTime: '10:00', endTime: '12:00' },
        { weekday: '每周五', startTime: '10:00', endTime: '12:00' },
      ]);
      expect(result).toContain('周一、三、五');
    });

    it('groups by (start, end, deadline) — different times stay in different parts', () => {
      const result = buildScheduleRule([
        { weekday: '每周一', startTime: '10:00', endTime: '12:00' },
        { weekday: '每周二', startTime: '14:00', endTime: '16:00' },
      ]);
      expect(result.split('；')).toHaveLength(2);
    });

    it('emits fixedDeadline as 截止 clause', () => {
      const result = buildScheduleRule([
        {
          weekday: '每周三',
          startTime: '13:30',
          endTime: '16:30',
          fixedDeadline: '2026-05-22 12:00',
        },
      ]);
      expect(result).toContain('截止 2026-05-22 12:00');
    });
  });

  describe('evaluateRequestedDate', () => {
    it('reports unavailable when no matching window for the date', () => {
      const result = evaluateRequestedDate({
        date: '2026-05-23', // 周六，没有窗口
        windows: [{ weekday: '每周三', startTime: '13:30', endTime: '16:30' }],
      });
      expect(result.status).toBe('unavailable');
      expect(result.canSchedule).toBe(false);
      expect(result.decisionBasis).toBe('no_matching_schedule');
    });

    it('reports available for a future weekday match', () => {
      const result = evaluateRequestedDate({
        date: '2026-05-20', // 周三
        windows: [{ weekday: '每周三', startTime: '13:30', endTime: '16:30' }],
      });
      expect(result.status).toBe('available');
      expect(result.canSchedule).toBe(true);
      expect(result.decisionBasis).toBe('future_schedule_match');
    });

    it('reports unavailable when deadline already past', () => {
      const result = evaluateRequestedDate({
        date: '2026-05-20',
        windows: [
          {
            weekday: '每周三',
            startTime: '13:30',
            endTime: '16:30',
            fixedDeadline: '2026-05-19 08:00', // < FIXED_NOW
          },
        ],
      });
      expect(result.status).toBe('unavailable');
      expect(result.decisionBasis).toBe('after_booking_deadline');
      expect(result.reason).toContain('报名截止');
    });

    it('reports same_day_before_window when today and windows have not started yet', () => {
      // FIXED_NOW = 09:00；窗口 13:30 → 还没开始
      const result = evaluateRequestedDate({
        date: '2026-05-19',
        windows: [{ weekday: '每周二', startTime: '13:30', endTime: '16:30' }],
      });
      expect(result.status).toBe('available');
      expect(result.decisionBasis).toBe('same_day_before_window');
    });

    it('reports same_day_after_latest_window when today and all windows ended', () => {
      // FIXED_NOW = 09:00；窗口 06:00-08:00 → 已结束
      const result = evaluateRequestedDate({
        date: '2026-05-19',
        windows: [{ weekday: '每周二', startTime: '06:00', endTime: '08:00' }],
      });
      expect(result.status).toBe('unavailable');
      expect(result.decisionBasis).toBe('same_day_after_latest_window');
    });

    it('reports same_day_window_requires_confirmation when window already started but not ended', () => {
      // FIXED_NOW = 09:00；窗口 08:00-12:00 → 进行中
      const result = evaluateRequestedDate({
        date: '2026-05-19',
        windows: [{ weekday: '每周二', startTime: '08:00', endTime: '12:00' }],
      });
      expect(result.status).toBe('needs_confirmation');
      expect(result.canSchedule).toBeNull();
      expect(result.decisionBasis).toBe('same_day_window_requires_confirmation');
    });

    it('forwards basePolicyNotes verbatim', () => {
      const result = evaluateRequestedDate({
        date: '2026-05-20',
        windows: [{ weekday: '每周三', startTime: '13:30', endTime: '16:30' }],
        basePolicyNotes: ['note A', 'note B'],
      });
      expect(result.policyNotes).toEqual(['note A', 'note B']);
    });
  });
});

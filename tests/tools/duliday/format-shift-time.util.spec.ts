import {
  composeShiftTimeBrief,
  composeShiftTimeText,
} from '@tools/duliday/format-shift-time.util';

describe('composeShiftTimeText', () => {
  describe('null cases', () => {
    it('returns null for empty workTime', () => {
      expect(composeShiftTimeText(null)).toBeNull();
      expect(composeShiftTimeText(undefined)).toBeNull();
      expect(composeShiftTimeText({})).toBeNull();
    });

    it('returns null when only month/day work hour limits exist (no specific shift)', () => {
      expect(
        composeShiftTimeText({
          monthWorkTime: { perMonthMinWorkTime: 80 },
          dayWorkTime: { perDayMinWorkHours: 4 },
        }),
      ).toBeNull();
    });

    it('returns null when fixedTime is broad operating range (≥ 2h up window)', () => {
      // 上班 5:00-23:00 实际是营业时段范围，不是班次
      expect(
        composeShiftTimeText({
          dailyShiftSchedule: {
            fixedTime: {
              goToWorkStartTime: '05:00',
              goToWorkEndTime: '23:00',
              goOffWorkStartTime: '05:00',
              goOffWorkEndTime: '23:00',
            },
          },
        }),
      ).toBeNull();
    });

    it('returns null when slot is dirty 00:00-00:00', () => {
      expect(
        composeShiftTimeText({
          dailyShiftSchedule: {
            fixedScheduleList: [{ fixedShiftStartTime: '00:00', fixedShiftEndTime: '00:00' }],
          },
        }),
      ).toBeNull();
    });
  });

  describe('single shift', () => {
    it('renders fixedTime narrow window as single shift with label', () => {
      // 06:30-10:00 → 早班，约 3.5 小时
      expect(
        composeShiftTimeText({
          dailyShiftSchedule: {
            fixedTime: {
              goToWorkStartTime: '06:30',
              goToWorkEndTime: '07:00',
              goOffWorkStartTime: '09:30',
              goOffWorkEndTime: '10:00',
            },
          },
        }),
      ).toBe('06:30-10:00（早班，约 3.5 小时）');
    });

    it('renders single fixedScheduleList entry', () => {
      expect(
        composeShiftTimeText({
          dailyShiftSchedule: {
            fixedScheduleList: [{ fixedShiftStartTime: '07:30', fixedShiftEndTime: '15:30' }],
          },
        }),
      ).toBe('07:30-15:30（早班，约 8 小时）');
    });
  });

  describe('multi shift (pick_one)', () => {
    it('renders multi fixedScheduleList as candidate-pick-one with labels', () => {
      const text = composeShiftTimeText({
        dailyShiftSchedule: {
          fixedScheduleList: [
            { fixedShiftStartTime: '07:30', fixedShiftEndTime: '15:30' },
            { fixedShiftStartTime: '10:00', fixedShiftEndTime: '20:00' },
            { fixedShiftStartTime: '15:30', fixedShiftEndTime: '23:30' },
          ],
        },
      });
      expect(text).toContain('班次可选其一：');
      expect(text).toContain('- 07:30-15:30（早班，约 8 小时）');
      expect(text).toContain('- 10:00-20:00（上午班，全天班，约 10 小时）');
      expect(text).toContain('- 15:30-23:30（下午班，约 8 小时）');
    });
  });

  describe('weekday-bound (combinedArrangement)', () => {
    it('renders combinedArrangement single weekday-bound shift', () => {
      const text = composeShiftTimeText({
        dailyShiftSchedule: {
          combinedArrangement: [
            {
              combinedArrangementStartTime: '11:30',
              combinedArrangementEndTime: '13:30',
              combinedArrangementWeekdays: '每周一,每周二,每周三,每周四,每周五',
            },
          ],
        },
      });
      expect(text).toContain('周一至周五');
      expect(text).toContain('11:30-13:30');
      expect(text).toContain('午高峰短班');
    });

    it('renders multi combinedArrangement entries', () => {
      const text = composeShiftTimeText({
        dailyShiftSchedule: {
          combinedArrangement: [
            {
              combinedArrangementStartTime: '11:30',
              combinedArrangementEndTime: '13:30',
              combinedArrangementWeekdays: '每周一,每周二,每周三,每周四,每周五',
            },
            {
              combinedArrangementStartTime: '09:00',
              combinedArrangementEndTime: '18:00',
              combinedArrangementWeekdays: '每周六,每周日',
            },
          ],
        },
      });
      expect(text).toContain('周一至周五 11:30-13:30');
      expect(text).toContain('周末 09:00-18:00');
    });
  });

  describe('cross-midnight', () => {
    it('formats overnight shift with 次日 prefix', () => {
      expect(
        composeShiftTimeText({
          dailyShiftSchedule: {
            fixedScheduleList: [{ fixedShiftStartTime: '22:00', fixedShiftEndTime: '06:00' }],
          },
        }),
      ).toBe('22:00-次日 06:00（夜班，约 8 小时）');
    });
  });

  describe('flexible arrangement', () => {
    it('renders flexible-style summary instead of slots', () => {
      const text = composeShiftTimeText({
        dailyShiftSchedule: { arrangementType: '弹性' },
        monthWorkTime: { perMonthMinWorkTime: 80 },
      });
      expect(text).toContain('弹性排班');
      expect(text).toContain('每月最少 80 小时');
    });
  });

  describe('priority: fixedScheduleList > combinedArrangement > fixedTime', () => {
    it('prefers fixedScheduleList over combinedArrangement', () => {
      const text = composeShiftTimeText({
        dailyShiftSchedule: {
          fixedScheduleList: [{ fixedShiftStartTime: '07:30', fixedShiftEndTime: '15:30' }],
          combinedArrangement: [
            {
              combinedArrangementStartTime: '09:00',
              combinedArrangementEndTime: '18:00',
              combinedArrangementWeekdays: '每周一,每周二',
            },
          ],
        },
      });
      expect(text).toContain('07:30-15:30');
      expect(text).not.toContain('09:00-18:00');
    });
  });
});

describe('composeShiftTimeBrief', () => {
  it('returns same single-line for single shift', () => {
    expect(
      composeShiftTimeBrief({
        dailyShiftSchedule: {
          fixedScheduleList: [{ fixedShiftStartTime: '07:30', fixedShiftEndTime: '15:30' }],
        },
      }),
    ).toBe('07:30-15:30（早班，约 8 小时）');
  });

  it('compresses multi shift to time ranges joined by /', () => {
    expect(
      composeShiftTimeBrief({
        dailyShiftSchedule: {
          fixedScheduleList: [
            { fixedShiftStartTime: '07:30', fixedShiftEndTime: '15:30' },
            { fixedShiftStartTime: '15:30', fixedShiftEndTime: '23:30' },
          ],
        },
      }),
    ).toBe('07:30-15:30 / 15:30-23:30');
  });

  it('returns null when no shift data', () => {
    expect(composeShiftTimeBrief({})).toBeNull();
  });
});

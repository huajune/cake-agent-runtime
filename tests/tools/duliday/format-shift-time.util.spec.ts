import { composeShiftTimeText } from '@tools/utils/format-shift-time.util';

/**
 * 海绵2.0 workTime 结构（dayWorkTime + weekAndMonthWorkTime）下的班次文案组合。
 *
 * arrangementType 真实取值：
 * - '满足其中一个时段即可安排上岗'（固定排班制，候选人选其一）
 * - '满足所有时段才可安排上岗'（组合排班制，全部需出勤）
 * - '灵活排班'（fixedTime 为上下班区间/窗口）
 */
describe('composeShiftTimeText (海绵2.0 dayWorkTime/weekAndMonthWorkTime)', () => {
  describe('null cases', () => {
    it('returns null for empty workTime', () => {
      expect(composeShiftTimeText(null)).toBeNull();
      expect(composeShiftTimeText(undefined)).toBeNull();
      expect(composeShiftTimeText({})).toBeNull();
    });

    it('returns null when only week/month hour limits exist (no specific shift)', () => {
      expect(
        composeShiftTimeText({
          weekAndMonthWorkTime: { perMonthMinWorkTime: 80 },
          dayWorkTime: {},
        }),
      ).toBeNull();
    });

    it('returns null when combinedArrangement slot is dirty 00:00-00:00', () => {
      expect(
        composeShiftTimeText({
          dayWorkTime: {
            arrangementType: '满足其中一个时段即可安排上岗',
            combinedArrangement: [
              { combinedArrangementStartTime: '00:00', combinedArrangementEndTime: '00:00' },
            ],
          },
        }),
      ).toBeNull();
    });
  });

  describe('single shift', () => {
    it('renders single combinedArrangement slot with label', () => {
      expect(
        composeShiftTimeText({
          dayWorkTime: {
            arrangementType: '满足其中一个时段即可安排上岗',
            combinedArrangement: [
              { combinedArrangementStartTime: '07:30', combinedArrangementEndTime: '15:30' },
            ],
          },
        }),
      ).toBe('07:30-15:30（早班，约 8 小时）');
    });

    it('单段跨度≥12h 视为排班窗口，不输出"全天班约N小时"误导（badcase recvkHHRbA0toe/recvkjGiU7oSL9）', () => {
      // 05:00-23:00（18h 跨度）无每日最少工时数据时，按窗口呈现而非"全天班约18小时"
      const text = composeShiftTimeText({
        dayWorkTime: {
          arrangementType: '满足其中一个时段即可安排上岗',
          combinedArrangement: [
            { combinedArrangementStartTime: '05:00', combinedArrangementEndTime: '23:00' },
          ],
        },
      });
      expect(text).toContain('排班窗口');
      expect(text).not.toContain('全天班');
      expect(text).not.toMatch(/约 1[0-9] 小时/);
    });

    it('renders 灵活排班 fixedTime as a concrete overnight shift', () => {
      // 通宵 22:00-次日07:00，跨度 9h、每日至少 8h → 跨度仅比工时多 1h，按具体班次而非窗口
      const text = composeShiftTimeText({
        dayWorkTime: {
          arrangementType: '灵活排班',
          fixedTime: {
            perDayMinWorkHours: '8',
            shiftCodes: ['通宵班'],
            goToWorkStartTime: '22:00',
            goOffWorkEndTime: '07:00',
            goOffWorkTimeType: '次日',
          },
        },
      });
      expect(text).toContain('22:00-次日 07:00');
      expect(text).toContain('夜班');
    });
  });

  describe('multi shift — 固定排班制 (pick_one)', () => {
    it('renders 满足其中一个 multi slots as candidate-pick-one', () => {
      const text = composeShiftTimeText({
        dayWorkTime: {
          arrangementType: '满足其中一个时段即可安排上岗',
          combinedArrangement: [
            { combinedArrangementStartTime: '07:30', combinedArrangementEndTime: '15:30' },
            { combinedArrangementStartTime: '15:30', combinedArrangementEndTime: '23:30' },
          ],
        },
      });
      expect(text).toContain('班次可选其一：');
      expect(text).toContain('- 07:30-15:30（早班，约 8 小时）');
      expect(text).toContain('- 15:30-23:30（下午班，约 8 小时）');
    });
  });

  describe('multi shift — 组合排班制 (all_required)', () => {
    it('renders 满足所有时段 multi slots as all-required', () => {
      const text = composeShiftTimeText({
        dayWorkTime: {
          arrangementType: '满足所有时段才可安排上岗',
          combinedArrangement: [
            { combinedArrangementStartTime: '11:00', combinedArrangementEndTime: '14:00' },
            { combinedArrangementStartTime: '17:00', combinedArrangementEndTime: '21:00' },
          ],
        },
      });
      expect(text).toContain('组合班次，全部需出勤：');
      expect(text).toContain('- 11:00-14:00');
      expect(text).toContain('- 17:00-21:00');
    });
  });

  describe('flexible window', () => {
    it('renders wide 灵活排班 fixedTime window with per-day min hours', () => {
      // 09:00-22:00 跨度 13h，每日至少 4h → 排班窗口而非"全天班"
      expect(
        composeShiftTimeText({
          dayWorkTime: {
            arrangementType: '灵活排班',
            fixedTime: {
              perDayMinWorkHours: '4',
              goToWorkStartTime: '09:00',
              goOffWorkEndTime: '22:00',
            },
          },
        }),
      ).toBe('09:00-22:00 排班窗口（每日至少 4 小时）');
    });
  });

  describe('cross-midnight', () => {
    it('formats overnight combinedArrangement with 次日 prefix', () => {
      expect(
        composeShiftTimeText({
          dayWorkTime: {
            arrangementType: '满足其中一个时段即可安排上岗',
            combinedArrangement: [
              { combinedArrangementStartTime: '22:00', combinedArrangementEndTime: '06:00' },
            ],
          },
        }),
      ).toBe('22:00-次日 06:00（夜班，约 8 小时）');
    });
  });

  describe('flexible arrangement summary', () => {
    it('falls back to flexible summary when 灵活排班 has no concrete fixedTime', () => {
      const text = composeShiftTimeText({
        dayWorkTime: { arrangementType: '灵活排班' },
        weekAndMonthWorkTime: { perMonthMinWorkTime: 80 },
      });
      expect(text).toContain('弹性排班');
      expect(text).toContain('每月最少 80 小时');
    });

    it('returns null for non-flexible arrangement without concrete shift data', () => {
      expect(
        composeShiftTimeText({
          dayWorkTime: { arrangementType: '满足其中一个时段即可安排上岗' },
          weekAndMonthWorkTime: { perMonthMinWorkTime: 80 },
        }),
      ).toBeNull();
    });
  });
});

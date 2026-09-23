import { formatLocalMinute } from '@infra/utils/date.util';
import { computeFollowUpDue, isWorkday } from '@notification/feishu-task/intervention-task-due';
import type { InterventionTaskCategory } from '@notification/feishu-task/intervention-task-category';

/** 上海本地时间构造真实时间点。 */
function sh(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}

function due(
  category: InterventionTaskCategory,
  triggeredAt: Date,
  interviewAt?: Date | null,
): ReturnType<typeof computeFollowUpDue> & { dueText: string; startText: string } {
  const result = computeFollowUpDue({ category, triggeredAt, interviewAt });
  return {
    ...result,
    dueText: formatLocalMinute(result.dueAt),
    startText: formatLocalMinute(result.startAt),
  };
}

const SAME_DAY_CATEGORIES: InterventionTaskCategory[] = ['T3', 'T4', 'T5', 'T8', 'UNCLASSIFIED'];

describe('intervention-task-due（所有任务日清）', () => {
  describe('isWorkday（2026 日历）', () => {
    it('周一到周五是工作日，周末不是', () => {
      expect(isWorkday(sh(2026, 9, 22))).toBe(true); // 周二
      expect(isWorkday(sh(2026, 9, 12))).toBe(false); // 周六
      expect(isWorkday(sh(2026, 9, 13))).toBe(false); // 周日
    });

    it('法定节假日不是工作日，调休周末是工作日', () => {
      expect(isWorkday(sh(2026, 10, 1))).toBe(false); // 国庆
      expect(isWorkday(sh(2026, 9, 25))).toBe(false); // 中秋
      expect(isWorkday(sh(2026, 9, 20))).toBe(true); // 周日调休上班
      expect(isWorkday(sh(2026, 10, 10))).toBe(true); // 周六调休上班
    });
  });

  describe('上班时间内触发：分钟档', () => {
    it('T1 15 分钟 / T7 30 分钟 / T2 1 小时 / T6 2 小时', () => {
      const at = sh(2026, 9, 22, 10, 0);
      expect(due('T1', at).dueText).toBe('2026-09-22 10:15');
      expect(due('T7', at).dueText).toBe('2026-09-22 10:30');
      expect(due('T2', at).dueText).toBe('2026-09-22 11:00');
      expect(due('T6', at).dueText).toBe('2026-09-22 12:00');
      expect(due('T2', at).offHoursTrigger).toBe(false);
    });

    it('T2 在 17:30 触发：正好用完当天 1 小时 → 18:30；T6 用掉 1 小时后次日 10:30', () => {
      expect(due('T2', sh(2026, 9, 22, 17, 30)).dueText).toBe('2026-09-22 18:30');
      expect(due('T6', sh(2026, 9, 22, 17, 30)).dueText).toBe('2026-09-23 10:30');
    });

    it('18:20 触发 T1：剩余 5 分钟顺到次日 9:35（= 起算点 + 15 上班分钟下限）', () => {
      expect(due('T1', sh(2026, 9, 22, 18, 20)).dueText).toBe('2026-09-23 09:35');
    });
  });

  describe('上班时间内触发：当日档（T3/T4/T5/T8/未归类 = 起算日 18:30）', () => {
    it('10:00 触发一律当天 18:30', () => {
      const at = sh(2026, 9, 22, 10, 0);
      for (const category of SAME_DAY_CATEGORIES) {
        expect(due(category, at).dueText).toBe('2026-09-22 18:30');
      }
    });

    it('16:30 之后触发仍取当天 18:30（不再顺到次日 12:00）', () => {
      expect(due('T3', sh(2026, 9, 22, 16, 30)).dueText).toBe('2026-09-22 18:30');
      expect(due('T8', sh(2026, 9, 22, 18, 0)).dueText).toBe('2026-09-22 18:30');
      expect(due('T3', sh(2026, 9, 11, 17, 0)).dueText).toBe('2026-09-11 18:30'); // 周五当天
    });

    it('18:20 触发：当天 18:30 早于起算点 + 15 上班分钟 → 次日 9:45', () => {
      for (const category of SAME_DAY_CATEGORIES) {
        expect(due(category, sh(2026, 9, 22, 18, 20)).dueText).toBe('2026-09-23 09:45');
      }
    });

    it('18:16 触发：18:30 满足不了 +15 → 「当日」整体顺到次日 9:45（不跨夜续算剩余分钟）；18:15 正好 18:30', () => {
      expect(due('T4', sh(2026, 9, 22, 18, 16)).dueText).toBe('2026-09-23 09:45');
      expect(due('T4', sh(2026, 9, 22, 18, 15)).dueText).toBe('2026-09-22 18:30');
    });

    it('对照：分钟档 T1 在 18:20 触发仍按剩余分钟跨夜顺延 → 次日 9:35', () => {
      expect(due('T1', sh(2026, 9, 22, 18, 20)).dueText).toBe('2026-09-23 09:35');
    });
  });

  describe('下班 / 周末 / 节假日触发', () => {
    it('18:30 及之后触发取次日 9:30 起算', () => {
      const result = due('T2', sh(2026, 9, 22, 18, 30));
      expect(result.startText).toBe('2026-09-23 09:30');
      expect(result.dueText).toBe('2026-09-23 10:30');
      expect(result.offHoursTrigger).toBe(true);
      expect(due('T5', sh(2026, 9, 22, 18, 30)).dueText).toBe('2026-09-23 18:30');
    });

    it('早上 9:30 前触发取当天 9:30 起算', () => {
      expect(due('T1', sh(2026, 9, 22, 8, 0)).dueText).toBe('2026-09-22 09:45');
      expect(due('T3', sh(2026, 9, 22, 8, 0)).dueText).toBe('2026-09-22 18:30');
    });

    it('周五晚触发顺到周一 9:30', () => {
      expect(due('T2', sh(2026, 9, 11, 20, 0)).dueText).toBe('2026-09-14 10:30');
      expect(due('T1', sh(2026, 9, 11, 20, 0)).dueText).toBe('2026-09-14 09:45');
      expect(due('T8', sh(2026, 9, 11, 20, 0)).dueText).toBe('2026-09-14 18:30');
    });

    it('周五晚遇调休周日上班：顺到周日 9:30', () => {
      expect(due('T2', sh(2026, 9, 18, 20, 0)).startText).toBe('2026-09-20 09:30');
    });

    it('周末触发：T4/T5 当日档 = 周一 18:30', () => {
      const at = sh(2026, 9, 12, 14, 0);
      expect(due('T4', at).dueText).toBe('2026-09-14 18:30');
      expect(due('T5', at).dueText).toBe('2026-09-14 18:30');
    });

    it('国庆前夜触发跨整个假期', () => {
      // 9-30 周三 17:30 T6 用掉 1 小时；10-1 至 10-7 放假；10-8 周四 9:30 + 1 小时
      expect(due('T6', sh(2026, 9, 30, 17, 30)).dueText).toBe('2026-10-08 10:30');
      // 当日档在假期前一天下班后触发 → 假后首个工作日 18:30
      expect(due('T3', sh(2026, 9, 30, 19, 0)).dueText).toBe('2026-10-08 18:30');
    });

    it('周五 18:00 触发遇周六调休上班：顺到周六', () => {
      // 10-9 周五 18:00 T6 用掉 30 分钟，10-10 周六上班 9:30 + 90 分钟
      expect(due('T6', sh(2026, 10, 9, 18, 0)).dueText).toBe('2026-10-10 11:00');
    });

    it('中秋假期内触发顺到假后首个工作日', () => {
      expect(due('T7', sh(2026, 9, 26, 10, 0)).dueText).toBe('2026-09-28 10:00');
    });
  });

  describe('面试上限（只对 T2、T6，规则不变）', () => {
    it('面试时间 − 1 小时晚于起算点 + 30 分钟时取较早者', () => {
      const at = sh(2026, 9, 22, 10, 0);
      // T2 常规 11:00，cap 11:00 → 11:00；T6 常规 12:00，cap 11:00 → 11:00
      expect(due('T2', at, sh(2026, 9, 22, 12, 0)).dueText).toBe('2026-09-22 11:00');
      expect(due('T6', at, sh(2026, 9, 22, 12, 0)).dueText).toBe('2026-09-22 11:00');
      expect(due('T6', at, sh(2026, 9, 22, 11, 45)).dueText).toBe('2026-09-22 10:45');
    });

    it('面试 − 1 小时不晚于起算点 + 30 分钟时不套上限', () => {
      const at = sh(2026, 9, 22, 10, 0);
      expect(due('T2', at, sh(2026, 9, 22, 11, 30)).dueText).toBe('2026-09-22 11:00');
      expect(due('T6', at, sh(2026, 9, 22, 11, 30)).dueText).toBe('2026-09-22 12:00');
    });

    it('面试 − 1 小时落在下班时间时不套上限', () => {
      const at = sh(2026, 9, 22, 17, 0);
      // 面试次日 9:00，cap 8:00 不在上班时间；常规算法 T2 → 当天 18:00
      expect(due('T2', at, sh(2026, 9, 23, 9, 0)).dueText).toBe('2026-09-22 18:00');
      expect(due('T2', at, sh(2026, 9, 23, 9, 0)).interviewImminent).toBe(false);
    });

    it('下班期间触发且面试早于下一个上班时段：到期取起算点（+15 分钟下限）并标临近', () => {
      const result = due('T2', sh(2026, 9, 22, 20, 0), sh(2026, 9, 23, 9, 0));
      expect(result.startText).toBe('2026-09-23 09:30');
      expect(result.dueText).toBe('2026-09-23 09:45');
      expect(result.interviewImminent).toBe(true);
      expect(result.offHoursTrigger).toBe(true);
    });

    it('上班中触发但面试已过：同样取起算点 + 15 分钟并标已过', () => {
      const result = due('T2', sh(2026, 9, 22, 10, 0), sh(2026, 9, 22, 9, 0));
      expect(result.dueText).toBe('2026-09-22 10:15');
      expect(result.interviewImminent).toBe(true);
    });

    it('T1 / 当日档等其他大类忽略面试时间', () => {
      const at = sh(2026, 9, 22, 10, 0);
      expect(due('T1', at, sh(2026, 9, 22, 9, 0)).dueText).toBe('2026-09-22 10:15');
      expect(due('T1', at, sh(2026, 9, 22, 9, 0)).interviewImminent).toBe(false);
      expect(due('T3', at, sh(2026, 9, 22, 12, 0)).dueText).toBe('2026-09-22 18:30');
    });
  });

  it('所有到期时间都落在上班时间 9:30–18:30 内，且不早于起算点 + 15 分钟', () => {
    const triggers = [
      sh(2026, 9, 22, 9, 0),
      sh(2026, 9, 22, 18, 16),
      sh(2026, 9, 22, 18, 25),
      sh(2026, 9, 22, 23, 59),
      sh(2026, 9, 12, 3, 0),
      sh(2026, 10, 3, 12, 0),
    ];
    const categories: InterventionTaskCategory[] = [
      'T1',
      'T2',
      'T3',
      'T4',
      'T5',
      'T6',
      'T7',
      'T8',
      'UNCLASSIFIED',
    ];
    for (const at of triggers) {
      for (const category of categories) {
        const result = due(category, at);
        const clock = result.dueText.slice(11);
        expect(clock >= '09:30' && clock <= '18:30').toBe(true);
        expect(isWorkday(result.dueAt)).toBe(true);
        expect(result.dueAt.getTime() - result.startAt.getTime()).toBeGreaterThanOrEqual(
          15 * 60 * 1000,
        );
      }
    }
  });

  it('所有大类都在起算日当天或次一工作日内到期（日清）', () => {
    const at = sh(2026, 9, 22, 10, 0);
    const categories: InterventionTaskCategory[] = [
      'T1',
      'T2',
      'T3',
      'T4',
      'T5',
      'T6',
      'T7',
      'T8',
      'UNCLASSIFIED',
    ];
    for (const category of categories) {
      expect(due(category, at).dueText.slice(0, 10)).toBe('2026-09-22');
    }
  });
});

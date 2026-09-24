import {
  findUnsupportedExclusiveShiftFields,
  formatExclusiveShiftFields,
  stripExclusiveShiftFields,
} from '@tools/job-list/schedule-provenance.util';

describe('schedule-provenance.util', () => {
  describe('findUnsupportedExclusiveShiftFields', () => {
    it('收资表单的"周末两天都在接受门店排班"是可用性，不支撑 onlyWeekends', () => {
      expect(
        findUnsupportedExclusiveShiftFields({ onlyWeekends: true }, [
          '周末两天是否在岗：周末两天都在接受门店排班',
        ]),
      ).toEqual(['onlyWeekends']);
    });

    it('候选人原话"我只能做周末"支撑 onlyWeekends', () => {
      expect(
        findUnsupportedExclusiveShiftFields({ onlyWeekends: true }, ['我只能做周末，平时要上课']),
      ).toEqual([]);
    });

    it('"找周六的兼职"这类求职表达同样构成依据', () => {
      expect(
        findUnsupportedExclusiveShiftFields({ onlyWeekends: true }, ['想找周六的兼职']),
      ).toEqual([]);
    });

    it('逐字段判定：周末有依据、晚班没有，只拒晚班', () => {
      expect(
        findUnsupportedExclusiveShiftFields({ onlyWeekends: true, onlyEvenings: true }, [
          '我只做周末',
        ]),
      ).toEqual(['onlyEvenings']);
    });

    it('依据可以落在会话中的任意一条候选人消息上', () => {
      expect(
        findUnsupportedExclusiveShiftFields({ onlyMornings: true }, [
          '你好',
          '我只想做早班，下午要带小孩',
        ]),
      ).toEqual([]);
    });

    it('"只有晚班吗"是候选人在问岗位，不是自陈排他性约束', () => {
      expect(
        findUnsupportedExclusiveShiftFields({ onlyEvenings: true }, ['这个岗位只有晚班吗']),
      ).toEqual(['onlyEvenings']);
    });

    it('出处池不可用（null）时整体放行，与品牌出处闸同口径', () => {
      expect(findUnsupportedExclusiveShiftFields({ onlyWeekends: true }, null)).toEqual([]);
    });

    it('未断言排他性字段时不产生拦截', () => {
      expect(
        findUnsupportedExclusiveShiftFields({ onlyWeekends: false }, ['周末两天都在接受门店排班']),
      ).toEqual([]);
      expect(findUnsupportedExclusiveShiftFields(undefined, ['随便什么话'])).toEqual([]);
    });

    it('候选人原话为空数组时，所有断言字段都缺依据', () => {
      expect(
        findUnsupportedExclusiveShiftFields({ onlyWeekends: true, onlyMornings: true }, []),
      ).toEqual(['onlyWeekends', 'onlyMornings']);
    });
  });

  describe('stripExclusiveShiftFields', () => {
    it('只剥指定字段，其余原样保留，且不改动入参', () => {
      const input = { onlyWeekends: true, onlyEvenings: true, maxDaysPerWeek: 2 };
      const kept = stripExclusiveShiftFields(input, ['onlyWeekends']);
      expect(kept).toEqual({ onlyEvenings: true, maxDaysPerWeek: 2 });
      expect(input.onlyWeekends).toBe(true);
    });

    it('无字段需剥离时返回原对象', () => {
      const input = { onlyWeekends: true };
      expect(stripExclusiveShiftFields(input, [])).toBe(input);
    });
  });

  it('formatExclusiveShiftFields 产出人读标签', () => {
    expect(formatExclusiveShiftFields(['onlyWeekends', 'onlyEvenings'])).toBe(
      '只能做周末（onlyWeekends）、只能做晚班（onlyEvenings）',
    );
  });
});

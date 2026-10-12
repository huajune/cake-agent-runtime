import { matchDailySchedule } from '@resolution/schedule/matcher';
import { WorkTimeContractError } from '@sponge/work-time.types';
import { getJobSchedule } from '@tools/job-list/schedule-normalizer.util';
import { scheduledJob, flexibleJob } from '../../helpers/job-schedule.fixture';

const fixed = getJobSchedule(
  scheduledJob(1, '固定排班', [
    ['08:00', '14:00'],
    ['15:00', '20:00'],
  ]),
);
const combo = getJobSchedule(
  scheduledJob(2, '组合排班制', [
    ['08:00', '14:00'],
    ['15:00', '20:00'],
  ]),
);
describe('结构化班次匹配', () => {
  it('固定全部满足，组合任一整档满足', () => {
    const constraint = { availableWindow: { start: '15:00', end: '21:00' } };
    expect(matchDailySchedule(fixed, constraint).status).toBe('unmatched');
    expect(matchDailySchedule(combo, constraint)).toMatchObject({
      status: 'matched',
      mode: 'time',
      matchedSlotIndexes: [1],
    });
  });
  it('重叠不能代替完整包含', () => {
    expect(
      matchDailySchedule(combo, { availableWindow: { start: '16:00', end: '21:00' } }).status,
    ).toBe('unmatched');
  });
  it('只有起点或终点也能精确过滤', () => {
    expect(
      matchDailySchedule(combo, { availableWindow: { start: '15:00' } }).matchedSlotIndexes,
    ).toEqual([1]);
    expect(
      matchDailySchedule(combo, { availableWindow: { end: '14:00' } }).matchedSlotIndexes,
    ).toEqual([0]);
  });
  it('具体时间优先于正向标签，避免旧早晚班条件二次过滤', () => {
    expect(
      matchDailySchedule(combo, {
        includeAnyTags: ['night'],
        availableWindow: { start: '15:00', end: '21:00' },
      }).status,
    ).toBe('matched');
  });
  it('正向标签取或，负向标签检查岗位所有标签', () => {
    expect(matchDailySchedule(combo, { includeAnyTags: ['early', 'morning'] }).status).toBe(
      'matched',
    );
    expect(matchDailySchedule(combo, { excludeTags: ['morning'] }).status).toBe('unmatched');
  });
  it('不可用时间与任何必选班次重叠时排除，端点相接可接受', () => {
    expect(
      matchDailySchedule(fixed, { unavailableWindow: { start: '14:00', end: '15:00' } }).status,
    ).toBe('matched');
    expect(
      matchDailySchedule(fixed, { unavailableWindow: { start: '13:59', end: '15:00' } }).status,
    ).toBe('unmatched');
  });
  it('不把多档时长相加成每日工时', () => {
    expect(matchDailySchedule(fixed, { maxShiftHours: 6 }).status).toBe('matched');
    expect(matchDailySchedule(fixed, { minShiftHours: 6 }).status).toBe('unmatched');
    expect(matchDailySchedule(combo, { minShiftHours: 6 }).matchedSlotIndexes).toEqual([0]);
  });
  it('组合排班的正向标签和时长必须由同一档满足', () => {
    const shifts = getJobSchedule(
      scheduledJob(7, '组合排班制', [
        ['17:00', '01:00'],
        ['08:00', '12:00'],
      ]),
    );
    expect(
      matchDailySchedule(shifts, { includeAnyTags: ['evening'], maxShiftHours: 4 }).status,
    ).toBe('unmatched');
    expect(
      matchDailySchedule(shifts, { includeAnyTags: ['morning'], minShiftHours: 8 }).status,
    ).toBe('unmatched');
    expect(
      matchDailySchedule(shifts, {
        includeAnyTags: ['evening', 'morning'],
        maxShiftHours: 4,
      }),
    ).toMatchObject({ status: 'matched', matchedSlotIndexes: [1] });
    expect(
      matchDailySchedule(shifts, {
        includeAnyTags: ['evening'],
        minShiftHours: 8,
      }),
    ).toMatchObject({ status: 'matched', matchedSlotIndexes: [0] });
  });
  it('明确时段和时长共同生效时仍忽略派生的正向标签', () => {
    expect(
      matchDailySchedule(combo, {
        includeAnyTags: ['night'],
        availableWindow: { start: '15:00', end: '21:00' },
        maxShiftHours: 5,
      }),
    ).toMatchObject({ status: 'matched', matchedSlotIndexes: [1] });
  });
  it('固定排班仍按岗位标签粗筛，且全部必选档都满足时长', () => {
    expect(
      matchDailySchedule(fixed, { includeAnyTags: ['morning'], maxShiftHours: 6 }),
    ).toMatchObject({ status: 'matched', matchedSlotIndexes: [0, 1] });
    expect(
      matchDailySchedule(fixed, { includeAnyTags: ['morning'], maxShiftHours: 5 }).status,
    ).toBe('unmatched');
  });
  it('跨日窗口可容纳次日凌晨档；跨日班次不可越过结束边界', () => {
    const night = getJobSchedule(scheduledJob(4, '固定排班', [['00:00', '06:00']]));
    expect(
      matchDailySchedule(night, {
        availableWindow: { start: '22:00', end: '06:00', endDayOffset: 1 },
      }).status,
    ).toBe('matched');
    const overnight = getJobSchedule(scheduledJob(5, '固定排班', [['22:00', '07:00']]));
    expect(
      matchDailySchedule(overnight, { availableWindow: { start: '18:30', end: '24:00' } }).status,
    ).toBe('unmatched');
    expect(
      matchDailySchedule(overnight, { unavailableWindow: { start: '06:00', end: '08:00' } }).status,
    ).toBe('unmatched');
  });
  it('灵活排班须整段接受排班区间，不因只给窗口和工时而待确认', () => {
    const flex = getJobSchedule(flexibleJob());
    expect(matchDailySchedule(flex, { availableWindow: { start: '20:00' } }).status).toBe(
      'unmatched',
    );
    expect(matchDailySchedule(flex, { availableWindow: { start: '18:00' } })).toMatchObject({
      status: 'unmatched',
      mode: 'time',
    });
    expect(matchDailySchedule(flex, { availableWindow: { start: '05:00' } })).toMatchObject({
      status: 'matched',
      mode: 'time',
      matchedSlotIndexes: [],
    });
    expect(
      matchDailySchedule(flex, { availableWindow: { start: '05:00', end: '22:59' } }).status,
    ).toBe('unmatched');
    expect(
      matchDailySchedule(flex, { unavailableWindow: { start: '17:00', end: '19:00' } }).status,
    ).toBe('unmatched');
    expect(
      matchDailySchedule(flex, { unavailableWindow: { start: '01:00', end: '03:00' } }).status,
    ).toBe('matched');
  });
  it('灵活排班按门店安排的每班时长比较候选人时长要求', () => {
    const flex = getJobSchedule(flexibleJob());
    expect(matchDailySchedule(flex, { minShiftHours: 4, maxShiftHours: 4 })).toMatchObject({
      status: 'matched',
      mode: 'time',
    });
    expect(matchDailySchedule(flex, { minShiftHours: 5 }).status).toBe('unmatched');
    expect(matchDailySchedule(flex, { maxShiftHours: 3 }).status).toBe('unmatched');
  });
  it('灵活排班按排班区间标签参与粗筛与排除', () => {
    const flex = getJobSchedule(flexibleJob());
    expect(matchDailySchedule(flex, { includeAnyTags: ['evening'] })).toMatchObject({
      status: 'matched',
      mode: 'tag',
    });
    expect(matchDailySchedule(flex, { includeAnyTags: ['night'] }).status).toBe('unmatched');
    expect(matchDailySchedule(flex, { excludeTags: ['evening'] }).status).toBe('unmatched');
    expect(
      matchDailySchedule(flex, {
        availableWindow: { start: '05:00', end: '23:00' },
        excludeTags: ['night'],
      }).status,
    ).toBe('matched');
  });
  it('跨日灵活排班区间按同一业务日整段对齐', () => {
    const overnight = getJobSchedule(flexibleJob(6, '22:00', '07:00', '6', true));
    const window = { start: '22:00', end: '07:00', endDayOffset: 1 as const };
    expect(matchDailySchedule(overnight, { availableWindow: window }).status).toBe('matched');
    expect(
      matchDailySchedule(overnight, { availableWindow: { start: '00:00', end: '06:00' } }).status,
    ).toBe('unmatched');
    expect(
      matchDailySchedule(overnight, {
        availableWindow: window,
        unavailableWindow: { start: '02:00', end: '03:00' },
      }).status,
    ).toBe('unmatched');
    expect(matchDailySchedule(overnight, { excludeTags: ['night'] }).status).toBe('unmatched');
  });
  it('有日内条件但岗位缺少班次数据时按契约错误抛出，不产出待确认', () => {
    expect(() => matchDailySchedule(null, { includeAnyTags: ['night'] })).toThrow(
      WorkTimeContractError,
    );
    expect(() => matchDailySchedule(null, { minShiftHours: 4 })).toThrow(
      '已有班次条件但岗位缺少班次数据',
    );
    expect(matchDailySchedule(null, {})).toMatchObject({ status: 'matched', mode: 'none' });
    expect(matchDailySchedule(null, { onlyWeekends: true }).status).toBe('matched');
  });
  it('只限时长时按班次时段判定', () => {
    expect(matchDailySchedule(fixed, { maxShiftHours: 6 })).toMatchObject({
      status: 'matched',
      mode: 'time',
    });
    expect(matchDailySchedule(combo, { minShiftHours: 6 }).mode).toBe('time');
    expect(matchDailySchedule(combo, {}).mode).toBe('none');
  });
  it('组合排班按正向标签匹配时只返回带该标签的档', () => {
    expect(matchDailySchedule(combo, { includeAnyTags: ['early', 'morning'] })).toMatchObject({
      status: 'matched',
      mode: 'tag',
      matchedSlotIndexes: [0],
    });
  });
});

describe('刚好24:00结束的班次', () => {
  const midnight = getJobSchedule(scheduledJob(8, '固定排班', [['16:00', '00:00']]));

  it('不算跨零点，完全按已有标签判定', () => {
    expect(matchDailySchedule(midnight, { includeAnyTags: ['evening', 'night'] })).toMatchObject({
      status: 'matched',
      mode: 'tag',
      matchedSlotIndexes: [0],
    });
    expect(
      matchDailySchedule(midnight, {
        includeAnyTags: ['early', 'morning', 'midday', 'afternoon', 'evening', 'night'],
      }).status,
    ).toBe('matched');
    expect(matchDailySchedule(midnight, { excludeTags: ['night'] }).status).toBe('matched');
    expect(matchDailySchedule(midnight, { includeAnyTags: ['night'] }).status).toBe('unmatched');
    expect(matchDailySchedule(midnight, { excludeTags: ['evening', 'night'] }).status).toBe(
      'unmatched',
    );
  });

  it('固定排班另有跨零点班次时仍因夜班被排除', () => {
    const withOvernight = getJobSchedule(
      scheduledJob(9, '固定排班', [
        ['16:00', '00:00'],
        ['22:00', '02:00'],
      ]),
    );
    expect(matchDailySchedule(withOvernight, { excludeTags: ['night'] })).toMatchObject({
      status: 'unmatched',
      reason: '岗位包含候选人排除的班次标签',
    });
  });
});

describe('具体可上班时段与排除标签同时生效', () => {
  const window = { start: '15:00', end: '21:00' };

  it('时间符合且岗位不含排除标签才匹配，时间不符直接排除', () => {
    const afternoon = getJobSchedule(scheduledJob(10, '固定排班', [['15:00', '21:00']]));
    const morning = getJobSchedule(scheduledJob(11, '固定排班', [['08:00', '12:00']]));
    expect(
      matchDailySchedule(afternoon, { availableWindow: window, excludeTags: ['night'] }),
    ).toMatchObject({ status: 'matched', mode: 'time', matchedSlotIndexes: [0] });
    expect(
      matchDailySchedule(morning, { availableWindow: window, excludeTags: ['night'] }).status,
    ).toBe('unmatched');
    expect(
      matchDailySchedule(combo, { excludeTags: ['night'], availableWindow: { start: '15:00' } }),
    ).toMatchObject({ status: 'matched', matchedSlotIndexes: [1] });
  });

  it('时间符合但岗位含排除标签时排除', () => {
    const late = getJobSchedule(scheduledJob(12, '固定排班', [['21:00', '23:00']]));
    expect(
      matchDailySchedule(late, {
        availableWindow: { start: '15:00', end: '24:00' },
        excludeTags: ['night'],
      }),
    ).toMatchObject({ status: 'unmatched', reason: '岗位包含候选人排除的班次标签' });
  });

  it('组合排班按岗位标签并集排除，不因另有一档符合时间而放行', () => {
    const mixed = getJobSchedule(
      scheduledJob(13, '组合排班制', [
        ['15:00', '20:00'],
        ['21:00', '02:00'],
      ]),
    );
    expect(
      matchDailySchedule(mixed, { availableWindow: { start: '15:00' }, excludeTags: ['night'] })
        .status,
    ).toBe('unmatched');
    const day = getJobSchedule(
      scheduledJob(14, '组合排班制', [
        ['08:00', '12:00'],
        ['15:00', '20:00'],
      ]),
    );
    expect(
      matchDailySchedule(day, { availableWindow: window, excludeTags: ['night'] }),
    ).toMatchObject({ status: 'matched', matchedSlotIndexes: [1] });
  });

  it('固定排班须全部班次符合时间', () => {
    const split = getJobSchedule(
      scheduledJob(15, '固定排班', [
        ['15:00', '20:00'],
        ['08:00', '12:00'],
      ]),
    );
    expect(
      matchDailySchedule(split, { availableWindow: window, excludeTags: ['night'] }).status,
    ).toBe('unmatched');
  });
});

describe('仅给不可用时段时正向标签照常生效', () => {
  const unavailableNoon = { start: '12:00', end: '14:00' };

  it('不可用时段只作额外排除，不替代正向标签', () => {
    const early = getJobSchedule(scheduledJob(16, '固定排班', [['08:00', '11:00']]));
    const evening = getJobSchedule(scheduledJob(17, '固定排班', [['17:00', '21:00']]));
    expect(
      matchDailySchedule(early, {
        includeAnyTags: ['evening'],
        unavailableWindow: unavailableNoon,
      }),
    ).toMatchObject({ status: 'unmatched', mode: 'tag' });
    expect(
      matchDailySchedule(evening, {
        includeAnyTags: ['evening'],
        unavailableWindow: unavailableNoon,
      }),
    ).toMatchObject({ status: 'matched', mode: 'tag', matchedSlotIndexes: [0] });
    expect(
      matchDailySchedule(evening, {
        includeAnyTags: ['evening'],
        unavailableWindow: { start: '18:00', end: '19:00' },
      }).status,
    ).toBe('unmatched');
  });

  it('组合排班须由同一档同时满足正向标签与不可用时段', () => {
    const shifts = getJobSchedule(
      scheduledJob(18, '组合排班制', [
        ['11:00', '14:00'],
        ['17:00', '21:00'],
      ]),
    );
    expect(
      matchDailySchedule(shifts, {
        includeAnyTags: ['midday'],
        unavailableWindow: { start: '11:00', end: '14:00' },
      }).status,
    ).toBe('unmatched');
    expect(
      matchDailySchedule(shifts, {
        includeAnyTags: ['midday'],
        unavailableWindow: { start: '18:00', end: '19:00' },
      }),
    ).toMatchObject({ status: 'matched', matchedSlotIndexes: [0] });
  });

  it('固定排班按岗位标签并集命中正向标签，且全部班次避开不可用时段', () => {
    expect(
      matchDailySchedule(fixed, {
        includeAnyTags: ['evening'],
        unavailableWindow: unavailableNoon,
      }).status,
    ).toBe('unmatched');
    expect(
      matchDailySchedule(fixed, {
        includeAnyTags: ['evening'],
        unavailableWindow: { start: '14:00', end: '15:00' },
      }),
    ).toMatchObject({ status: 'matched', matchedSlotIndexes: [0, 1] });
    expect(
      matchDailySchedule(fixed, {
        includeAnyTags: ['early'],
        unavailableWindow: { start: '14:00', end: '15:00' },
      }).status,
    ).toBe('unmatched');
  });
});

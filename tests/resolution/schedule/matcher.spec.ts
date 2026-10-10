import { matchDailySchedule } from '@resolution/schedule/matcher';
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
  it('灵活排班连续交集不足时排除，足够时仍待确认，不拼接碎片', () => {
    const flex = getJobSchedule(flexibleJob());
    expect(matchDailySchedule(flex, { availableWindow: { start: '20:00' } }).status).toBe(
      'unmatched',
    );
    expect(matchDailySchedule(flex, { availableWindow: { start: '18:00' } }).status).toBe(
      'unknown',
    );
    expect(
      matchDailySchedule(flex, {
        availableWindow: { start: '15:00', end: '21:00' },
        unavailableWindow: { start: '17:00', end: '19:00' },
      }).status,
    ).toBe('unmatched');
  });
  it('跨日灵活岗位的凌晨可用时间足够时待确认，不误判无匹配', () => {
    const overnight = getJobSchedule(flexibleJob(6, '22:00', '07:00', '6', true));
    expect(
      matchDailySchedule(overnight, { availableWindow: { start: '00:00', end: '06:00' } }),
    ).toMatchObject({ status: 'unknown', mode: 'time' });
    expect(
      matchDailySchedule(overnight, { availableWindow: { start: '00:00', end: '05:59' } }).status,
    ).toBe('unmatched');
    expect(
      matchDailySchedule(overnight, {
        availableWindow: { start: '00:00', end: '06:00' },
        unavailableWindow: { start: '02:00', end: '03:00' },
      }).status,
    ).toBe('unmatched');
  });
  it('缺班次、独立负标签与时间并存、零点夜班边界都不能假装匹配', () => {
    expect(matchDailySchedule(null, { includeAnyTags: ['night'] }).status).toBe('unknown');
    expect(
      matchDailySchedule(combo, { excludeTags: ['night'], availableWindow: { start: '15:00' } })
        .status,
    ).toBe('unknown');
    expect(
      matchDailySchedule(getJobSchedule(scheduledJob(1, '固定排班', [['16:00', '00:00']])), {
        excludeTags: ['night'],
      }).status,
    ).toBe('unknown');
  });
});

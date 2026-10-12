import { WorkTimeContractError, parseDayWorkTime } from '@sponge/work-time.types';
import { formatJobShiftTime } from '@tools/job-list/format-shift-time.util';
import { scheduledJob, flexibleJob } from '../helpers/job-schedule.fixture';

describe('海绵每日班次契约', () => {
  it.each([
    {
      arrangementType: '满足其中一个时段即可安排上岗',
      combinedArrangement: [
        { combinedArrangementStartTime: '08:00', combinedArrangementEndTime: '12:00' },
      ],
      fixedTime: null,
    },
    {
      arrangementType: '组合排班制',
      combinedArrangement: [
        { combinedArrangementStartTime: '08:00', combinedArrangementEndTime: '12:00' },
      ],
      fixedTime: null,
    },
    {
      arrangementType: '固定排班',
      combinedArrangement: [
        { combinedArrangementStartTime: '05:00', combinedArrangementEndTime: '05:00' },
      ],
      fixedTime: null,
    },
    {
      arrangementType: '固定排班',
      combinedArrangement: [
        { combinedArrangementStartTime: '8:00', combinedArrangementEndTime: '12:00' },
      ],
      fixedTime: null,
    },
    {
      arrangementType: '固定排班',
      combinedArrangement: [
        { combinedArrangementStartTime: '08:00', combinedArrangementEndTime: '12:00' },
      ],
    },
    { arrangementType: '固定排班', combinedArrangement: [], fixedTime: null },
  ])('非法源数据不补值、不改类型、不跳过: %j', (day) =>
    expect(() => parseDayWorkTime({ dayWorkTime: day }, 99)).toThrow(/岗位99/),
  );
  it('拒绝未知日内字段及不合理灵活窗口', () => {
    const day = parseDayWorkTime(scheduledJob(1, '固定排班', [['08:00', '12:00']]).workTime);
    expect(() => parseDayWorkTime({ dayWorkTime: { ...day, extra: '值' } })).toThrow(
      WorkTimeContractError,
    );
    expect(() => formatJobShiftTime(flexibleJob(2, '08:00', '12:00', '6'))).toThrow(
      WorkTimeContractError,
    );
    expect(() => formatJobShiftTime(flexibleJob(2, '08:00', '12:00', '6', true))).toThrow(
      WorkTimeContractError,
    );
  });
});

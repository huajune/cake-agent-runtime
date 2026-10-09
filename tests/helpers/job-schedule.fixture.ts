import type { JobDetail } from '@sponge/sponge.types';

export function scheduledJob(
  id: number,
  type: '固定排班' | '组合排班制',
  ranges: Array<[string, string]>,
): JobDetail {
  return {
    basicInfo: { jobId: id, brandName: 'KFC', jobName: '服务员' },
    workTime: {
      dayWorkTime: {
        arrangementType: type,
        fixedTime: null,
        combinedArrangement: ranges.map(([start, end]) => ({
          combinedArrangementStartTime: start,
          combinedArrangementEndTime: end,
        })),
      },
    },
  };
}
export function flexibleJob(
  id = 3,
  start = '05:00',
  end = '23:00',
  minimum = '4',
  nextDay = false,
): JobDetail {
  return {
    basicInfo: { jobId: id, brandName: 'KFC', jobName: '服务员' },
    workTime: {
      dayWorkTime: {
        arrangementType: '灵活排班',
        combinedArrangement: null,
        fixedTime: {
          perDayMinWorkHours: minimum,
          shiftCodes: ['早班', '中班', '晚班'],
          goToWorkStartTime: start,
          goOffWorkEndTime: end,
          goOffWorkTimeType: nextDay ? '次日' : '当日',
        },
      },
    },
  };
}

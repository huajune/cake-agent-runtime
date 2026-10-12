import { getJobSchedule } from '@tools/job-list/schedule-normalizer.util';
import { scheduledJob, flexibleJob } from '../../helpers/job-schedule.fixture';

describe('海绵班次归一化', () => {
  it('同一岗位对象复用结果，新取回的同ID岗位使用最新排班', () => {
    const oldJob = scheduledJob(7, '固定排班', [['08:00', '12:00']]);
    expect(getJobSchedule(oldJob)).toBe(getJobSchedule(oldJob));
    const freshJob = scheduledJob(7, '固定排班', [['18:00', '02:00']]);
    expect(getJobSchedule(freshJob)).toMatchObject({
      arrangementType: '固定排班',
      slots: [{ index: 0, startMinute: 1080, endMinute: 1560, tags: ['evening', 'night'] }],
      tags: ['evening', 'night'],
    });
  });

  it('灵活窗口保留跨日与最低工时，不生成虚构的完整班次', () => {
    const schedule = getJobSchedule(flexibleJob(8, '22:00', '07:00', '8', true));
    expect(schedule).toEqual({
      arrangementType: '灵活排班',
      window: { startMinute: 1320, endMinute: 1860 },
      minimumMinutes: 480,
    });
    expect(getJobSchedule({ basicInfo: { jobId: 8 } })).toBeNull();
  });
});

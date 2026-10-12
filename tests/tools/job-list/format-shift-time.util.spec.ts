import { composeShiftTimeText, formatJobShiftTime } from '@tools/job-list/format-shift-time.util';
import { WorkTimeContractError } from '@sponge/work-time.types';
import { scheduledJob, flexibleJob } from '../../helpers/job-schedule.fixture';
import { mapJobsToRecommendedSummaries } from '@tools/job-list/job-summary.util';
import { formatJobsToMarkdown } from '@tools/job-list/render.util';

describe('共享结构化班次展示与契约', () => {
  it('固定排班逐档展示、接受全部，不把长档猜成灵活窗口', () => {
    const job = scheduledJob(1, '固定排班', [['10:00', '22:00']]);
    const text = formatJobShiftTime(job);
    expect(text).toContain('需接受全部班次');
    expect(text).toContain('班次跨度 12 小时');
    expect(text).not.toContain('窗口');
  });
  it('组合排班任选一个完整班次，摘要、详情与卡片关系一致', () => {
    const job = scheduledJob(2, '组合排班制', [
      ['07:00', '14:00'],
      ['07:00', '15:00'],
    ]);
    const text = formatJobShiftTime(job);
    expect(text).toContain('任选其中一档完整班次');
    expect(text).toContain('07:00-14:00');
    expect(text).toContain('07:00-15:00');
    expect(mapJobsToRecommendedSummaries([job])[0].shiftSummary).toBe(text);
    const md = formatJobsToMarkdown([job], 1, 1, 20, {
      includeBasicInfo: true,
      includeJobSalary: false,
      includeWelfare: false,
      includeHiringRequirement: false,
      includeWorkTime: true,
      includeInterviewProcess: false,
    });
    expect(md).toContain(text);
    expect(md).not.toContain('组合排班制，下面列出的');
  });
  it('灵活班展示最低工时，窗口不当成实际工时', () => {
    const text = formatJobShiftTime(flexibleJob(3, '22:00', '07:00', '8', true));
    expect(text).toContain('窗口 22:00-次日07:00');
    expect(text).toContain('每日最少 8 小时');
    expect(text).toContain('实际可安排班次待确认');
    expect(text).not.toContain('9 小时');
  });
  it('跨日整档展示次日，24点也统一为次日零点', () => {
    expect(formatJobShiftTime(scheduledJob(4, '固定排班', [['18:00', '02:00']]))).toContain(
      '18:00-次日02:00',
    );
    expect(formatJobShiftTime(scheduledJob(4, '固定排班', [['18:00', '24:00']]))).toContain(
      '18:00-次日00:00',
    );
  });
  it('未请求工作时间可以为空，但不把非法已提供字段变成空数据', () => {
    expect(composeShiftTimeText(undefined)).toBeNull();
    expect(() => composeShiftTimeText({})).toThrow(WorkTimeContractError);
  });
});

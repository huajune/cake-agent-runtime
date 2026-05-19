import {
  applyScheduleConstraint,
  filterJobsByRequestedCategories,
  formatScheduleConstraintLabel,
  haversineDistance,
  scoreJobAgainstRequestedCategories,
} from '@tools/duliday/job-list/search.util';

describe('job-list search util', () => {
  it('calculates haversine distance in kilometers', () => {
    const distance = haversineDistance(31.2304, 121.4737, 31.2206, 121.5503);

    expect(distance).toBeGreaterThan(7);
    expect(distance).toBeLessThan(8);
  });

  it('scores requested categories against category/name/nickname/content and filters by relevance', () => {
    const service = makeJob(1, '服务员', '前厅服务员', '餐厅服务', '负责前台点餐');
    const cashier = makeJob(2, '收银员', '门店收银', '收银', '负责收银');
    const warehouse = makeJob(3, '分拣员', '仓库分拣', '仓储', '理货上架');

    expect(scoreJobAgainstRequestedCategories(service, ['服务员'])).toBeGreaterThan(
      scoreJobAgainstRequestedCategories(cashier, ['服务员']),
    );
    expect(filterJobsByRequestedCategories([cashier, warehouse, service], ['服务员'])).toEqual([
      service,
    ]);
  });

  it('formats candidate schedule constraints into a compact label', () => {
    expect(
      formatScheduleConstraintLabel({
        onlyWeekends: true,
        onlyEvenings: true,
        maxDaysPerWeek: 2,
      }),
    ).toBe('只周末 / 只晚班 / 每周最多 2 天');
    expect(formatScheduleConstraintLabel({})).toBe('未明确');
  });

  it('applies schedule constraints and records semantic exclusions', () => {
    const weekendJob = makeJob(1, '服务员', '周末短班', '餐饮', '可只做周末');
    const fullWeekJob = makeJob(2, '服务员', '全周排班', '餐饮', '每天 05:00-23:00 固定排班');

    const result = applyScheduleConstraint([fullWeekJob, weekendJob], { onlyWeekends: true });

    expect(result.jobs).toEqual([weekendJob]);
    expect((weekendJob as JobWithScheduleSemantic)._scheduleSemantic).toContain(
      'weekend_only_compatible',
    );
    expect(result.excluded).toEqual([
      {
        jobId: 2,
        brandName: '肯德基',
        reason: '岗位是全周强排班，与"只做周末"冲突',
      },
    ]);
  });
});

function makeJob(
  jobId: number,
  jobCategoryName: string,
  jobName: string,
  jobNickName: string,
  jobContent: string,
) {
  return {
    basicInfo: {
      jobId,
      brandName: '肯德基',
      jobCategoryName,
      jobName,
      jobNickName,
      jobContent,
    },
    workTime: { remark: jobContent },
    hiringRequirement: { remark: jobContent },
  };
}

type JobWithScheduleSemantic = ReturnType<typeof makeJob> & {
  _scheduleSemantic?: string[];
};

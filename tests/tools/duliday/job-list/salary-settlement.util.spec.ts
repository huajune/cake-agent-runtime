import { formatSettlementSummary } from '@tools/duliday/job-list/salary-settlement.util';

describe('salary settlement summary', () => {
  it('keeps formal daily pay separate from monthly training and stair differences', () => {
    expect(
      formatSettlementSummary({
        jobSalary: {
          salaryScenarioList: [
            { salaryType: '正式', salaryPeriod: '日结算', payday: '当日结' },
            { salaryType: '培训期', salaryPeriod: '月结算', payday: '10号' },
          ],
        },
        welfare: {
          remark: '每天按照20*实际出勤日结，阶梯部分&培训期间费用月结，每月10号发上月差价',
        },
      }),
    ).toBe(
      '正式:日结算（当日结发薪）；培训期:月结算（10号发薪）；基础工资按日结；阶梯差价按月结；培训费用按月结；每月10号发上月差价',
    );
  });

  it('returns a simple monthly summary without inventing supplemental rules', () => {
    expect(
      formatSettlementSummary({
        jobSalary: {
          salaryScenarioList: [{ salaryType: '正式', salaryPeriod: '月结算', payday: '15号' }],
        },
      }),
    ).toBe('正式:月结算（15号发薪）');
  });

  it('returns null when the source has no settlement facts', () => {
    expect(formatSettlementSummary({ jobSalary: null, welfare: null })).toBeNull();
  });
});

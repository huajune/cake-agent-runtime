import { detectSettlementCycleMismatch } from '@agent/guardrail/output/rules/settlement-cycle-mismatch.rule';
import { formatJobsToMarkdown } from '@tools/job-list/render.util';

describe('settlement renderer ↔ guardrail parser contract', () => {
  it('parses formal and supplemental settlement truth from the real job renderer', () => {
    const markdown = formatJobsToMarkdown(
      [
        {
          basicInfo: {
            jobId: 439472,
            brandName: '奥乐齐',
            jobName: '理货员',
            laborForm: '兼职',
            storeInfo: { storeName: '测试路店', storeCityName: '上海' },
          },
          jobSalary: {
            salaryScenarioList: [
              {
                salaryType: '正式',
                salaryPeriod: '日结算',
                payday: '当日结',
                basicSalary: { basicSalary: 20, basicSalaryUnit: '元/时' },
              },
              {
                salaryType: '培训期',
                salaryPeriod: '月结算',
                payday: '次月10号',
                basicSalary: { basicSalary: 18, basicSalaryUnit: '元/时' },
              },
            ],
          },
        },
      ],
      1,
      1,
      20,
      {
        includeBasicInfo: true,
        includeJobSalary: true,
        includeWelfare: false,
        includeHiringRequirement: false,
        includeWorkTime: false,
        includeInterviewProcess: false,
      },
    );

    expect(markdown).toContain('#### 薪资方案 1（正式）');
    expect(markdown).toContain('#### 薪资方案 2（培训期）');

    const productionShapedReply = [
      '[引用 候选人：这个岗位工资是日结吗]',
      '[图片消息]',
      '候选人连续两条消息合并后，回复：这边整份工资是按月结算的。',
      '[消息发送时间：2026-08-13 10:24:31]',
    ].join('\n');
    const toolCalls = [
      {
        toolName: 'duliday_job_list',
        args: { jobIdList: [439472] },
        status: 'ok' as const,
        result: { markdown },
      },
    ];

    expect(detectSettlementCycleMismatch(productionShapedReply, toolCalls, 439472)).toEqual(
      expect.objectContaining({ ruleId: 'settlement_cycle_mismatch' }),
    );
    expect(
      detectSettlementCycleMismatch(
        '基础工资日结，培训费用月结。[消息发送时间：2026-08-13 10:24:31]',
        toolCalls,
        439472,
      ),
    ).toBeNull();
  });
});

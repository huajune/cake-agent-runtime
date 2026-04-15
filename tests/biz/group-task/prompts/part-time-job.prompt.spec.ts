import {
  buildPartTimeJobUserMessage,
  buildPartTimeSalaryLine,
  enforcePartTimeSalaryLine,
  extractPartTimeHourlySalary,
  PART_TIME_JOB_SYSTEM_PROMPT,
} from '@biz/group-task/prompts/part-time-job.prompt';
import { JobDetail } from '@sponge/sponge.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    basicInfo: {
      jobId: 1,
      jobName: '服务员',
      jobNickName: '门店服务员',
      jobContent: '餐厅服务、点餐收银',
      laborForm: '小时工',
      requirementNum: 2,
      storeInfo: {
        storeName: '星河山海湾',
        storeRegionName: '天河区',
      },
    },
    jobSalary: {
      salaryScenarioList: [
        {
          basicSalary: { basicSalary: 20, basicSalaryUnit: '元/小时' },
        },
      ],
    },
    welfare: {},
    hiringRequirement: {},
    workTime: {},
    ...overrides,
  };
}

function makeData(
  jobs: JobDetail[],
  overrides: { brand?: string; city?: string; industry?: string } = {},
) {
  return {
    brand: overrides.brand ?? '肯德基',
    city: overrides.city ?? '广州',
    industry: overrides.industry ?? '餐饮',
    jobs,
  };
}

// ---------------------------------------------------------------------------
// PART_TIME_JOB_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe('PART_TIME_JOB_SYSTEM_PROMPT', () => {
  it('should be a non-empty string', () => {
    expect(typeof PART_TIME_JOB_SYSTEM_PROMPT).toBe('string');
    expect(PART_TIME_JOB_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('should describe the assistant role', () => {
    expect(PART_TIME_JOB_SYSTEM_PROMPT).toContain('兼职招聘群');
  });
});

// ---------------------------------------------------------------------------
// buildPartTimeJobUserMessage — top-level output
// ---------------------------------------------------------------------------

describe('buildPartTimeJobUserMessage', () => {
  describe('summary header', () => {
    it('should include brand, city, and job count', () => {
      const result = buildPartTimeJobUserMessage(makeData([makeJob(), makeJob()]));

      expect(result).toContain('肯德基');
      expect(result).toContain('广州');
      expect(result).toContain('2家');
    });

    it('should include salary when present', () => {
      const result = buildPartTimeJobUserMessage(makeData([makeJob()]));

      expect(result).toContain('20元/时');
      expect(result).toContain('固定薪资行（必须原样输出）: 💰 薪资待遇：20元/时');
    });

    it('should omit salary line when no salary data', () => {
      const job = makeJob({ jobSalary: {} });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).not.toMatch(/薪资:/);
    });

    it('should include total requirementNum when greater than zero', () => {
      const jobs = [
        makeJob({ basicInfo: { jobId: 1, requirementNum: 3, storeInfo: {} } }),
        makeJob({ basicInfo: { jobId: 2, requirementNum: 4, storeInfo: {} } }),
      ];
      const result = buildPartTimeJobUserMessage(makeData(jobs));

      expect(result).toContain('7人');
    });

    it('should omit total requirementNum line when all jobs have zero', () => {
      const job = makeJob({ basicInfo: { jobId: 1, requirementNum: 0, storeInfo: {} } });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).not.toMatch(/总招聘人数/);
    });

    it('should show common job content when all jobs share the same content', () => {
      const content = '餐厅服务、点餐收银';
      const jobs = [
        makeJob({ basicInfo: { jobId: 1, jobContent: content, storeInfo: {} } }),
        makeJob({ basicInfo: { jobId: 2, jobContent: content, storeInfo: {} } }),
      ];
      const result = buildPartTimeJobUserMessage(makeData(jobs));

      expect(result).toContain('工作内容（所有门店相同）');
      expect(result).toContain(content);
    });

    it('should not show common content header when job contents differ', () => {
      const jobs = [
        makeJob({ basicInfo: { jobId: 1, jobContent: '收银', storeInfo: {} } }),
        makeJob({ basicInfo: { jobId: 2, jobContent: '清洁', storeInfo: {} } }),
      ];
      const result = buildPartTimeJobUserMessage(makeData(jobs));

      expect(result).not.toContain('工作内容（所有门店相同）');
    });
  });

  describe('per-job listing', () => {
    it('should output a numbered entry for each job', () => {
      const jobs = [makeJob(), makeJob(), makeJob()];
      const result = buildPartTimeJobUserMessage(makeData(jobs));

      expect(result).toContain('【门店1】');
      expect(result).toContain('【门店2】');
      expect(result).toContain('【门店3】');
    });

    it('should include storeRegionName and storeName in each entry', () => {
      const job = makeJob({
        basicInfo: {
          jobId: 1,
          storeInfo: { storeName: '立白店', storeRegionName: '花都区' },
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('花都区');
      expect(result).toContain('立白店');
    });

    it('should omit laborForm from the prompt payload', () => {
      const result = buildPartTimeJobUserMessage(makeData([makeJob()]));
      expect(result).not.toContain('小时工');
    });

    it('should include requirementNum per job when present', () => {
      const job = makeJob({ basicInfo: { jobId: 1, requirementNum: 5, storeInfo: {} } });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('5人');
    });

    it('should ignore basicInfo age fields in per-job listing', () => {
      const job = makeJob({
        basicInfo: { jobId: 1, minAge: 18, maxAge: 45, storeInfo: {} },
        hiringRequirement: undefined,
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).not.toContain('18-45岁');
      expect(result).not.toMatch(/用人要求:/);
    });
  });

  // -------------------------------------------------------------------------
  // Max-display cap
  // -------------------------------------------------------------------------

  describe('max 15 jobs display cap', () => {
    it('should not append overflow note when jobs <= 15', () => {
      const jobs = Array.from({ length: 15 }, (_, i) =>
        makeJob({ basicInfo: { jobId: i + 1, storeInfo: {} } }),
      );
      const result = buildPartTimeJobUserMessage(makeData(jobs));

      expect(result).not.toContain('还有');
    });

    it('should append overflow note when jobs > 15', () => {
      const jobs = Array.from({ length: 18 }, (_, i) =>
        makeJob({ basicInfo: { jobId: i + 1, storeInfo: {} } }),
      );
      const result = buildPartTimeJobUserMessage(makeData(jobs));

      expect(result).toContain('（还有3个门店在招，未全部列出）');
    });

    it('should only list 15 entries even when 20 jobs are provided', () => {
      const jobs = Array.from({ length: 20 }, (_, i) =>
        makeJob({ basicInfo: { jobId: i + 1, storeInfo: {} } }),
      );
      const result = buildPartTimeJobUserMessage(makeData(jobs));

      expect(result).toContain('【门店15】');
      expect(result).not.toContain('【门店16】');
    });
  });

  // -------------------------------------------------------------------------
  // cleanStoreName (exercised via storeName in storeInfo)
  // -------------------------------------------------------------------------

  describe('cleanStoreName (via storeInfo.storeName)', () => {
    it('should remove trailing branch code like -GZ4200', () => {
      const job = makeJob({
        basicInfo: { jobId: 1, storeInfo: { storeName: '星河山海湾-GZ4200' } },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('星河山海湾');
      expect(result).not.toContain('GZ4200');
    });

    it('should strip KFC-GZ4175 pattern to just KFC', () => {
      const job = makeJob({
        basicInfo: { jobId: 1, storeInfo: { storeName: 'KFC-GZ4175' } },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('KFC');
      expect(result).not.toContain('GZ4175');
    });

    it('should remove person-name segment like 广州-张晓馥-星河山海湾 → 广州-星河山海湾', () => {
      const job = makeJob({
        basicInfo: { jobId: 1, storeInfo: { storeName: '广州-张晓馥-星河山海湾' } },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('广州-星河山海湾');
      expect(result).not.toContain('张晓馥');
    });

    it('should leave a plain store name unchanged', () => {
      const job = makeJob({
        basicInfo: { jobId: 1, storeInfo: { storeName: '大悦城商厦店' } },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('大悦城商厦店');
    });
  });

  // -------------------------------------------------------------------------
  // extractWorkTime
  // -------------------------------------------------------------------------

  describe('extractWorkTime (via workTime.workTimeList)', () => {
    it('should include work time range when workTimeList has startTime and endTime', () => {
      const job = makeJob({
        workTime: {
          workTimeList: [{ startTime: '09:00', endTime: '17:00' }],
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('09:00-17:00');
    });

    it('should join multiple time slots with semicolons', () => {
      const job = makeJob({
        workTime: {
          workTimeList: [
            { startTime: '09:00', endTime: '13:00' },
            { startTime: '17:00', endTime: '21:00' },
          ],
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('09:00-13:00');
      expect(result).toContain('17:00-21:00');
    });

    it('should omit time slot entry when workTimeList is empty', () => {
      const job = makeJob({ workTime: { workTimeList: [] } });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).not.toMatch(/时段:/);
    });

    it('should omit time slot entry when workTime is absent', () => {
      const job = makeJob({ workTime: undefined });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).not.toMatch(/时段:/);
    });
  });

  // -------------------------------------------------------------------------
  // extractSalary
  // -------------------------------------------------------------------------

  describe('extractSalary (via jobSalary.salaryScenarioList)', () => {
    it('should display single-scenario basicSalary with unit', () => {
      const job = makeJob({
        jobSalary: {
          salaryScenarioList: [{ basicSalary: { basicSalary: 15.5, basicSalaryUnit: '元/小时' } }],
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('15.5元/时');
    });

    it('should display monthly salary when only monthly comprehensiveSalary is present', () => {
      const job = makeJob({
        jobSalary: {
          salaryScenarioList: [
            {
              comprehensiveSalary: {
                minComprehensiveSalary: 3000,
                maxComprehensiveSalary: 5000,
                comprehensiveSalaryUnit: '元/月',
              },
            },
          ],
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('薪资: 3000-5000元/月');
      expect(result).toContain('固定薪资行（必须原样输出）: 💰 薪资待遇：3000-5000元/月');
    });

    it('should display min-max range for multi-scenario salary', () => {
      const job = makeJob({
        jobSalary: {
          salaryScenarioList: [
            { basicSalary: { basicSalary: 14, basicSalaryUnit: '元/小时' } },
            { basicSalary: { basicSalary: 18, basicSalaryUnit: '元/小时' } },
            { basicSalary: { basicSalary: 16, basicSalaryUnit: '元/小时' } },
          ],
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('14-18元/时');
    });

    it('should display single value when all multi-scenario salaries are equal', () => {
      const job = makeJob({
        jobSalary: {
          salaryScenarioList: [
            { basicSalary: { basicSalary: 16, basicSalaryUnit: '元/小时' } },
            { basicSalary: { basicSalary: 16, basicSalaryUnit: '元/小时' } },
          ],
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('16元/时');
      expect(result).not.toContain('16-16');
    });

    it('should ignore monthly max salary when hourly salary also exists', () => {
      const jobs = [
        makeJob({
          jobSalary: {
            salaryScenarioList: [
              { basicSalary: { basicSalary: 14.8, basicSalaryUnit: '元/小时' } },
              {
                comprehensiveSalary: {
                  minComprehensiveSalary: 3500,
                  maxComprehensiveSalary: 4300,
                  comprehensiveSalaryUnit: '元/月',
                },
              },
            ],
          },
        }),
        makeJob({
          basicInfo: { jobId: 2, storeInfo: {} },
          jobSalary: {
            salaryScenarioList: [{ basicSalary: { basicSalary: 18, basicSalaryUnit: '元/小时' } }],
          },
        }),
      ];
      const result = buildPartTimeJobUserMessage(makeData(jobs));

      expect(result).toContain('14.8-18元/时');
      expect(result).not.toContain('4300');
      expect(result).not.toContain('元/月');
    });

    it('should derive exact hourly range from base salary and stair salaries', () => {
      const job = makeJob({
        jobSalary: {
          salaryScenarioList: [
            {
              basicSalary: { basicSalary: 14.8, basicSalaryUnit: '元/时' },
              stairSalaries: [
                { salary: 15.4, salaryUnit: '元/时' },
                { salary: 19.1, salaryUnit: '元/时' },
              ],
              comprehensiveSalary: {
                minComprehensiveSalary: 1500,
                maxComprehensiveSalary: 3500,
                comprehensiveSalaryUnit: '元/月',
              },
            },
          ],
        },
      });

      expect(extractPartTimeHourlySalary([job])).toBe('14.8-19.1元/时');
    });

    it('should ignore holiday and overtime salary when deriving hourly range', () => {
      const job = makeJob({
        jobSalary: {
          salaryScenarioList: [
            {
              basicSalary: { basicSalary: 20, basicSalaryUnit: '元/时' },
              stairSalaries: [
                { salary: 22, salaryUnit: '元/时' },
                { salary: 24, salaryUnit: '元/时' },
              ],
              holidaySalary: { holidaySalary: 38, holidaySalaryUnit: '元/时' },
              overtimeSalary: { overtimeSalary: 57, overtimeSalaryUnit: '元/时' },
            },
          ],
        },
      });

      expect(extractPartTimeHourlySalary([job])).toBe('20-24元/时');
    });

    it('should omit salary line when salaryScenarioList is empty', () => {
      const job = makeJob({ jobSalary: { salaryScenarioList: [] } });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).not.toMatch(/薪资:/);
    });
  });

  describe('code-enforced salary line', () => {
    it('should build exact salary line from real hourly range', () => {
      const job = makeJob({
        jobSalary: {
          salaryScenarioList: [
            {
              basicSalary: { basicSalary: 19, basicSalaryUnit: '元/时' },
              stairSalaries: [
                { salary: 22, salaryUnit: '元/时' },
                { salary: 24, salaryUnit: '元/时' },
              ],
            },
          ],
        },
      });

      expect(buildPartTimeSalaryLine([job])).toBe('💰 薪资待遇：19-24元/时');
    });

    it('should fallback to monthly salary line when hourly salary is absent', () => {
      const job = makeJob({
        jobSalary: {
          salaryScenarioList: [
            {
              comprehensiveSalary: {
                minComprehensiveSalary: 6000,
                maxComprehensiveSalary: 9000,
                comprehensiveSalaryUnit: '元/月',
              },
            },
          ],
        },
      });

      expect(buildPartTimeSalaryLine([job])).toBe('💰 薪资待遇：6000-9000元/月');
    });

    it('should replace ai-generated salary block with the exact computed salary line', () => {
      const aiMessage = `🍕【必胜客·北京】69家门店招聘啦！

💰 薪资待遇：
- 时薪范围：19-22元/时
- 工作类型：小时工（灵活时间制）
👤 招聘对象：18-50岁
📝 工作内容：
• 点餐收银`;
      const job = makeJob({
        jobSalary: {
          salaryScenarioList: [
            {
              basicSalary: { basicSalary: 19, basicSalaryUnit: '元/时' },
              stairSalaries: [
                { salary: 22, salaryUnit: '元/时' },
                { salary: 24, salaryUnit: '元/时' },
              ],
            },
          ],
        },
      });

      const result = enforcePartTimeSalaryLine(aiMessage, [job]);

      expect(result).toContain('💰 薪资待遇：19-24元/时');
      expect(result).not.toContain('19-22元/时');
      expect(result).not.toContain('工作类型');
      expect(result).toContain('👤 招聘对象：18-50岁');
    });

    it('should insert computed monthly salary line when AI omits the salary module', () => {
      const aiMessage = `🥗【李维斯·上海】1家门店招聘啦！

👤 招聘对象：18-50岁
📝 工作内容：
• 商品推荐`;
      const job = makeJob({
        jobSalary: {
          salaryScenarioList: [
            {
              comprehensiveSalary: {
                minComprehensiveSalary: 6000,
                maxComprehensiveSalary: 9000,
                comprehensiveSalaryUnit: '元/月',
              },
            },
          ],
        },
      });

      const result = enforcePartTimeSalaryLine(aiMessage, [job]);

      expect(result).toContain('💰 薪资待遇：6000-9000元/月');
      expect(result).toContain('👤 招聘对象：18-50岁');
    });
  });

  // -------------------------------------------------------------------------
  // extractWelfare
  // -------------------------------------------------------------------------

  describe('extractWelfare (via welfare)', () => {
    it('should map 包吃 to 包一顿工作餐', () => {
      const job = makeJob({ welfare: { catering: '包吃' } });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('包一顿工作餐');
    });

    it('should exclude 不包吃 from welfare output', () => {
      const job = makeJob({ welfare: { catering: '不包吃' } });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).not.toContain('不包吃');
      expect(result).not.toMatch(/福利:/);
    });

    it('should exclude catering values containing 无', () => {
      const job = makeJob({ welfare: { catering: '无餐补' } });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).not.toContain('无餐补');
    });

    it('should include accommodation when it is a real value', () => {
      const job = makeJob({ welfare: { accommodation: '提供住宿' } });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('提供住宿');
    });

    it('should exclude 不包住 from welfare output', () => {
      const job = makeJob({ welfare: { accommodation: '不包住' } });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).not.toContain('不包住');
    });

    it('should combine catering and accommodation with 、', () => {
      const job = makeJob({ welfare: { catering: '包吃', accommodation: '提供住宿' } });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('包一顿工作餐、提供住宿');
    });

    it('should omit welfare line when welfare object is absent', () => {
      const job = makeJob({ welfare: undefined });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).not.toMatch(/福利:/);
    });
  });

  // -------------------------------------------------------------------------
  // extractHiringRequirement
  // -------------------------------------------------------------------------

  describe('extractHiringRequirement (via hiringRequirement)', () => {
    it('should include age range when minAge and maxAge are present', () => {
      const job = makeJob({
        hiringRequirement: {
          basicPersonalRequirements: { minAge: 18, maxAge: 50 },
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('年龄18-50岁');
    });

    it('should include gender when it is not 男性,女性', () => {
      const job = makeJob({
        hiringRequirement: {
          basicPersonalRequirements: { genderRequirement: '女性' },
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('女性');
    });

    it('should keep broad age copy when gender has no restriction', () => {
      const job = makeJob({
        hiringRequirement: {
          basicPersonalRequirements: { genderRequirement: '男性,女性' },
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      // Gender should not appear inside 用人要求 line — but storeName or other fields
      // may still contain characters; check the specific line.
      const lines = result.split('\n');
      const reqLine = lines.find((l) => l.startsWith('用人要求:'));
      expect(reqLine).toBe('用人要求: 年龄18-50岁');
    });

    it('should include education when it is not 不限', () => {
      const job = makeJob({
        hiringRequirement: {
          certificate: { education: '高中及以上' },
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('学历高中及以上');
    });

    it('should keep broad age copy when education is 不限', () => {
      const job = makeJob({
        hiringRequirement: {
          certificate: { education: '不限' },
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      const lines = result.split('\n');
      const reqLine = lines.find((l) => l.startsWith('用人要求:'));
      expect(reqLine).toBe('用人要求: 年龄18-50岁');
    });

    it('should include certificates when present', () => {
      const job = makeJob({
        hiringRequirement: {
          certificate: { certificates: '健康证' },
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('需健康证');
    });

    it('should include remark when present', () => {
      const job = makeJob({
        hiringRequirement: {
          remark: '需要能接受夜班',
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('需要能接受夜班');
    });

    it('should filter student, settlement, and social security remarks', () => {
      const job = makeJob({
        hiringRequirement: {
          remark:
            '需持有效健康证；坚决不接受学生（违规不予结算，已发亦追回扣除）；员工名下不能有社保',
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      const lines = result.split('\n');
      const reqLine = lines.find((l) => l.startsWith('用人要求:'));
      expect(reqLine).toBe('用人要求: 年龄18-50岁、需持有效健康证');
      expect(result).toContain('需持有效健康证');
      expect(result).not.toContain('不接受学生');
      expect(result).not.toContain('不予结算');
      expect(result).not.toContain('社保');
    });

    it('should join multiple requirement items with 、 after broad age copy', () => {
      const job = makeJob({
        hiringRequirement: {
          basicPersonalRequirements: { minAge: 20, maxAge: 40, genderRequirement: '女性' },
          certificate: { education: '高中及以上' },
        },
      });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).toContain('年龄18-50岁、女性、学历高中及以上');
    });

    it('should omit 用人要求 line when hiringRequirement is absent', () => {
      const job = makeJob({ hiringRequirement: undefined });
      const result = buildPartTimeJobUserMessage(makeData([job]));

      expect(result).not.toMatch(/用人要求:/);
    });
  });
});

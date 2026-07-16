import {
  formatJobsToMarkdown,
  inferStudentRequirement,
  ProgressiveDisclosureFlags,
} from '@tools/duliday/job-list/render.util';
import { JobPolicyAnalysis } from '@tools/utils/job-policy-parser';

describe('job-list render util', () => {
  const minimalFlags: ProgressiveDisclosureFlags = {
    includeBasicInfo: true,
    includeJobSalary: false,
    includeWelfare: false,
    includeHiringRequirement: false,
    includeWorkTime: false,
    includeInterviewProcess: false,
  };

  it('renders minimal markdown with one-line jobs and pagination hint', () => {
    const markdown = formatJobsToMarkdown([makeJob(1)], 3, 1, 1, minimalFlags);

    expect(markdown).toContain('# 在招岗位（共 3 个）');
    expect(markdown).toContain('本工具只查询岗位，**没有提交预约**');
    expect(markdown).toContain('只有 `duliday_interview_booking` 返回 success=true');
    expect(markdown).toContain('1. **肯德基 - 服务员** | 静安寺店 | 上海市静安区xx路 | 距离 2.3km');
    expect(markdown).toContain('_还有 2 个岗位未显示');
  });

  it('renders same-brand multi-store warning before detailed job sections', () => {
    const flags: ProgressiveDisclosureFlags = {
      ...minimalFlags,
      includeJobSalary: true,
      includeHiringRequirement: true,
      includeWorkTime: true,
    };
    const brandGroups = [
      {
        brandName: '肯德基',
        brandId: 100,
        totalStoreCount: 2,
        nearestStores: [
          {
            storeName: '静安寺店',
            jobId: 1,
            jobName: '餐饮',
            distanceKm: 2.3,
            wageRange: '24-29 元/时',
            shiftSummary: '11:00-15:00',
            requirementSummary: '18-45岁',
            displayLine: '肯德基（静安寺店，2.3km，11:00-15:00，24-29 元/时，18-45岁）',
          },
          {
            storeName: '日月光店',
            jobId: 2,
            jobName: '餐饮',
            distanceKm: 5.1,
            wageRange: '24-29 元/时',
            shiftSummary: '11:00-15:00',
            requirementSummary: null,
            displayLine: '肯德基（日月光店，5.1km，11:00-15:00，24-29 元/时）',
          },
        ],
      },
    ];

    const markdown = formatJobsToMarkdown([makeJob(1)], 1, 1, 10, flags, brandGroups);

    expect(markdown).toContain('⚠️ 同品牌多门店');
    expect(markdown).toContain('肯德基（静安寺店，2.3km，11:00-15:00，24-29 元/时，18-45岁）');
    expect(markdown).toContain('### 约面重点');
    expect(markdown).toContain('- **工作班次**:');
    expect(markdown).toContain('### 薪资信息');
    expect(markdown).toContain('### 招聘要求');
    expect(markdown).toContain('### 工作时间');
    expect(markdown.indexOf('⚠️ 同品牌多门店')).toBeLessThan(markdown.indexOf('## 1. 服务员'));
  });

  it('treats missing student restriction as no extra student hard gate', () => {
    const flags: ProgressiveDisclosureFlags = {
      ...minimalFlags,
      includeHiringRequirement: true,
    };
    const markdown = formatJobsToMarkdown([makeJob(1)], 1, 1, 10, flags);

    expect(markdown).toContain('未标注学生限制（按无额外学生硬限制处理）');
    expect(markdown).not.toContain('需确认');
  });

  it('marks insurance as sensitive in welfare markdown instead of ordinary active welfare', () => {
    const flags: ProgressiveDisclosureFlags = {
      ...minimalFlags,
      includeWelfare: true,
    };
    const job = makeJob(1) as ReturnType<typeof makeJob> & { welfare?: unknown };
    job.welfare = {
      haveInsurance: '公司购买',
      catering: '包吃',
    };

    const markdown = formatJobsToMarkdown([job], 1, 1, 10, flags);

    expect(markdown).toContain('保险/社保严禁主动提及');
    expect(markdown).toContain(
      '- **保险（敏感，仅候选人主动问时可答；主动推荐/福利介绍严禁提）**: 公司购买',
    );
    expect(markdown).toContain('- **餐饮**: 包吃');
    expect(markdown).not.toContain('- **保险**: 公司购买');
  });

  describe('hard-requirements banner', () => {
    const detailFlags: ProgressiveDisclosureFlags = {
      includeBasicInfo: true,
      includeJobSalary: false,
      includeWelfare: false,
      includeHiringRequirement: true,
      includeWorkTime: false,
      includeInterviewProcess: false,
    };

    it('does not render banner when all hard requirements unspecified/any', () => {
      const job = makeJob(1);
      // makeJob 默认 cert.healthCertificate="食品健康证" 会触发 before_onboard banner，
      // 这里覆盖为空，验证 unspecified 路径不渲染。
      job.hiringRequirement = {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
        figure: '不限',
      } as typeof job.hiringRequirement;
      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);
      expect(markdown).not.toContain('候选人硬性约束');
    });

    it('renders banner for gender + household exclude + health cert before_interview', () => {
      const job = makeJob(1);
      job.hiringRequirement = {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '女' },
        requirementsForHometown: {
          nativePlaceRequirementType: '不要',
          nativePlaces: ['东三省', '河南'],
        },
        certificate: { healthCertificate: '必须先办健康证' },
        figure: '不限',
      } as typeof job.hiringRequirement;
      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);

      expect(markdown).toContain('候选人硬性约束');
      expect(markdown).toContain('仅限女');
      expect(markdown).toContain('不接受 东三省/河南');
      expect(markdown).toContain('面试前必须持有健康证');
      const bannerIdx = markdown.indexOf('候选人硬性约束');
      const titleIdx = markdown.indexOf('## 1.');
      expect(bannerIdx).toBeGreaterThan(titleIdx);
    });

    it('renders only health cert before_onboard when nothing else specified', () => {
      const job = makeJob(1);
      job.hiringRequirement = {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
        certificate: { healthCertificate: '食品健康证' },
        figure: '不限',
      } as typeof job.hiringRequirement;
      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);

      expect(markdown).toContain('候选人硬性约束');
      expect(markdown).toContain('入职前必须办妥健康证');
      expect(markdown).not.toContain('仅限女');
      expect(markdown).not.toContain('仅限男');
    });
  });

  describe('sensitive screening free-text notice', () => {
    const detailFlags: ProgressiveDisclosureFlags = {
      includeBasicInfo: true,
      includeJobSalary: false,
      includeWelfare: false,
      includeHiringRequirement: true,
      includeWorkTime: false,
      includeInterviewProcess: true,
    };

    it('appends 🔒 notice when requirement free-text embeds household exclusion', () => {
      const job = makeJob(1);
      job.hiringRequirement = {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
        certificate: { healthCertificate: '食品健康证' },
        figure: '不限',
        remark: '能吃苦耐劳，不要新疆西藏籍',
      } as typeof job.hiringRequirement;
      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);

      expect(markdown).toContain('不要新疆西藏籍');
      expect(markdown).toContain('本节文本含户籍/籍贯/民族/专业/婚育等敏感筛选信息');
    });

    it('appends 🔒 notice when interview supplement embeds sensitive screening label', () => {
      const job = makeJob(1) as ReturnType<typeof makeJob> & { interviewProcess?: unknown };
      job.interviewProcess = {
        interviewSupplement: [{ interviewSupplement: '户籍（不要新疆西藏）' }],
      };
      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);

      const interviewSection = markdown.slice(markdown.indexOf('### 面试流程'));
      expect(interviewSection).toContain('本节文本含户籍/籍贯/民族/专业/婚育等敏感筛选信息');
    });

    it('does not duplicate notice when structured hometown warning already rendered', () => {
      const job = makeJob(1);
      job.hiringRequirement = {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
        requirementsForHometown: {
          nativePlaceRequirementType: '不要',
          nativePlaces: ['东三省', '河南'],
        },
        certificate: { healthCertificate: '食品健康证' },
        figure: '不限',
      } as typeof job.hiringRequirement;
      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);

      expect(markdown).toContain('上述民族/籍贯条件🔒仅供内部筛选');
      expect(markdown).not.toContain('本节文本含户籍/籍贯/民族/专业/婚育等敏感筛选信息');
    });

    it('does not append notice for ordinary jobs', () => {
      const markdown = formatJobsToMarkdown([makeJob(1)], 1, 1, 10, detailFlags);
      expect(markdown).not.toContain('本节文本含户籍/籍贯/民族/专业/婚育等敏感筛选信息');
    });

    it('marks structured marriage and childbearing requirements as internal-only', () => {
      const job = makeJob(1);
      job.hiringRequirement = {
        basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
        marriageBearingAndSocialSecurity: {
          marriageBearingType: '限制',
          marriageBearing: '已婚已育',
        },
        certificate: { healthCertificate: '' },
        figure: '不限',
      } as typeof job.hiringRequirement;

      const markdown = formatJobsToMarkdown([job], 1, 1, 10, detailFlags);

      expect(markdown).toContain('- **婚育要求**: 限制');
      expect(markdown).toContain('- **婚育状态**: 已婚已育');
      expect(markdown).toContain('户籍/籍贯/民族/专业/婚育等敏感筛选信息');
      expect(markdown).toContain('严禁向候选人展示或转述');
    });
  });

  describe('progressive disclosure (full-detail cap)', () => {
    const detailFlags: ProgressiveDisclosureFlags = {
      includeBasicInfo: true,
      includeJobSalary: true,
      includeWelfare: false,
      includeHiringRequirement: true,
      includeWorkTime: true,
      includeInterviewProcess: false,
    };

    it('renders full detail for all jobs when count <= cap (6)', () => {
      const jobs = [1, 2, 3, 4, 5, 6].map((id) => makeJob(id));
      const markdown = formatJobsToMarkdown(jobs, 6, 1, 10, detailFlags);

      // 6 个全文标题（## 1. ~ ## 6.），无摘要尾
      expect(markdown).toContain('## 1. 服务员');
      expect(markdown).toContain('## 6. 服务员');
      expect(markdown).not.toContain('### 更远的');
    });

    it('caps full detail to nearest 6 and summarizes the rest with jobId', () => {
      const jobs = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => makeJob(id));
      const markdown = formatJobsToMarkdown(jobs, 8, 1, 10, detailFlags);

      // 前 6 家全文
      expect(markdown).toContain('## 6. 服务员');
      // 第 7 家不再有全文详情标题
      expect(markdown).not.toContain('## 7. 服务员');
      // 摘要尾出现，带数量与 jobId 重查引导
      expect(markdown).toContain('### 更远的 2 家');
      expect(markdown).toContain('jobId:7');
      expect(markdown).toContain('jobId:8');
      // 摘要行带薪资（来自 formatSalarySummary）
      expect(markdown).toMatch(/7\. \*\*肯德基 - 服务员\*\*.*jobId:7/);
    });
  });

  it('infers student requirement from normalized policy text and field signals', () => {
    expect(inferStudentRequirement(makePolicy({ remark: '仅限非学生，需要已毕业' }))).toBe(
      '不接受学生',
    );
    expect(inferStudentRequirement(makePolicy({ demand: '学生优先报名' }))).toBe('学生优先');
    expect(
      inferStudentRequirement(makePolicy({ fieldSignalEvidence: '是否学生：学生也可报名' })),
    ).toBe('可接受学生');
    expect(inferStudentRequirement(makePolicy({}))).toBeNull();
  });
});

function makeJob(jobId: number) {
  return {
    basicInfo: {
      jobId,
      brandId: 100,
      brandName: '肯德基',
      jobName: '服务员',
      jobCategoryName: '餐饮',
      laborForm: '兼职',
      storeInfo: {
        storeId: 88,
        storeName: '上海静安寺店',
        storeCityName: '上海',
        storeRegionName: '静安区',
        storeAddress: '上海市静安区xx路',
      },
    },
    _distanceKm: 2.3,
    jobSalary: {
      salaryScenarioList: [
        {
          salaryType: '小时工',
          comprehensiveSalary: {
            minComprehensiveSalary: 24,
            maxComprehensiveSalary: 29,
            comprehensiveSalaryUnit: '元/时',
          },
        },
      ],
    },
    hiringRequirement: {
      basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
      certificate: { healthCertificate: '食品健康证' },
      figure: '不限',
    },
    workTime: {
      employmentForm: '长期用工',
      weekAndMonthWorkTime: {
        arrangementCycleType: '每周',
        weekMonthArrangementMode: '做几休几',
        perWeekWorkDays: 6,
        perWeekRestDays: 1,
      },
      dayWorkTime: {
        arrangementType: '满足其中一个时段即可安排上岗',
        combinedArrangement: [
          { combinedArrangementStartTime: '18:00', combinedArrangementEndTime: '22:00' },
        ],
        fixedTime: null,
      },
    },
  };
}

function makePolicy(input: {
  remark?: string;
  interviewRemark?: string;
  demand?: string;
  fieldSignalEvidence?: string;
}): JobPolicyAnalysis {
  return {
    interviewWindows: [],
    fieldGuidance: {
      screeningFields: [],
      bookingSubmissionFields: [],
      bookingSubmissionSource: 'api_submission_contract',
      deferredSubmissionFields: [],
      recommendedAskNowFields: [],
      fieldSignals: input.fieldSignalEvidence
        ? [
            {
              field: '是否学生',
              sourceField: 'interview_supplement',
              evidence: input.fieldSignalEvidence,
              confidence: 'high',
            },
          ]
        : [],
    },
    normalizedRequirements: {
      genderRequirement: '不限',
      ageRequirement: '不限',
      educationRequirement: '未明确要求',
      healthCertificateRequirement: '未明确要求',
      healthCertGate: 'unknown',
      remark: input.remark ?? null,
      interviewRemark: input.interviewRemark ?? null,
      interviewSupplements: [],
    },
    interviewMeta: {
      method: null,
      address: null,
      demand: input.demand ?? null,
      timeHint: null,
      registrationDeadlineHint: null,
    },
    highlights: {
      requirementHighlights: [],
      timingHighlights: [],
    },
  };
}

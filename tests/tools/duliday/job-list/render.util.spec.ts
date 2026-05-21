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
            distanceKm: 2.3,
            wageRange: '24-29 元/时',
            shiftSummary: '11:00-15:00',
            requirementSummary: '18-45岁',
            displayLine: '肯德基（静安寺店，2.3km，11:00-15:00，24-29 元/时，18-45岁）',
          },
          {
            storeName: '日月光店',
            jobId: 2,
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
      dailyShiftSchedule: {
        arrangementType: '固定排班制',
        fixedScheduleList: [{ fixedShiftStartTime: '18:00', fixedShiftEndTime: '22:00' }],
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

import {
  buildApiPayloadGuide,
  buildScreeningCriteria,
} from '@tools/duliday/precheck/screening-criteria.util';
import type { JobPolicyAnalysis } from '@tools/utils/job-policy-parser';

function makeAnalysis(overrides?: Partial<JobPolicyAnalysis>): JobPolicyAnalysis {
  return {
    interviewWindows: [],
    fieldGuidance: {
      screeningFields: [],
      bookingSubmissionFields: [],
      bookingSubmissionSource: 'api_submission_contract',
      deferredSubmissionFields: [],
      recommendedAskNowFields: [],
      fieldSignals: [],
    },
    normalizedRequirements: {
      genderRequirement: '不限',
      ageRequirement: '不限',
      educationRequirement: '不限',
      healthCertificateRequirement: '未明确要求',
      healthCertGate: 'unknown',
      remark: null,
      interviewRemark: null,
      interviewSupplements: [],
    },
    interviewMeta: {
      method: null,
      address: null,
      demand: null,
      timeHint: null,
      registrationDeadlineHint: null,
    },
    highlights: { requirementHighlights: [], timingHighlights: [] },
    ...overrides,
  };
}

describe('screening-criteria.util', () => {
  describe('buildScreeningCriteria', () => {
    it('omits gender / age / education / healthCert when unrestricted or unset', () => {
      const result = buildScreeningCriteria(makeAnalysis());
      expect(result.gender).toBeUndefined();
      expect(result.age).toBeUndefined();
      expect(result.education).toBeUndefined();
      expect(result.healthCertificate).toBeUndefined();
    });

    it('emits gender when single-gender requirement is set', () => {
      const result = buildScreeningCriteria(
        makeAnalysis({
          normalizedRequirements: {
            ...makeAnalysis().normalizedRequirements,
            genderRequirement: '男',
          },
        }),
      );
      expect(result.gender).toBe('男');
    });

    it('emits age when ageRequirement is concrete', () => {
      const result = buildScreeningCriteria(
        makeAnalysis({
          normalizedRequirements: {
            ...makeAnalysis().normalizedRequirements,
            ageRequirement: '25-50岁',
          },
        }),
      );
      expect(result.age).toBe('25-50岁');
    });

    it('emits education when not "不限"', () => {
      const result = buildScreeningCriteria(
        makeAnalysis({
          normalizedRequirements: {
            ...makeAnalysis().normalizedRequirements,
            educationRequirement: '高中及以上',
          },
        }),
      );
      expect(result.education).toBe('高中及以上');
    });

    it('emits healthCertificate when requirement is not "未明确要求"', () => {
      const result = buildScreeningCriteria(
        makeAnalysis({
          normalizedRequirements: {
            ...makeAnalysis().normalizedRequirements,
            healthCertificateRequirement: '必须有健康证',
          },
        }),
      );
      expect(result.healthCertificate).toBe('必须有健康证');
    });

    it('emits isStudent / experience / household / height / weight / resume from non-supplement signals', () => {
      const result = buildScreeningCriteria(
        makeAnalysis({
          fieldGuidance: {
            ...makeAnalysis().fieldGuidance,
            fieldSignals: [
              {
                field: '是否学生',
                sourceField: 'basic_personal_requirements',
                evidence: '仅限学生',
                confidence: 'high',
              },
              {
                field: '过往公司+岗位+年限',
                sourceField: 'hiring_remark',
                evidence: '至少3年餐饮',
                confidence: 'high',
              },
              {
                field: '户籍省份',
                sourceField: 'hiring_remark',
                evidence: '不要东北籍',
                confidence: 'high',
              },
              {
                field: '身高',
                sourceField: 'figure',
                evidence: '170cm 以上',
                confidence: 'high',
              },
              {
                field: '体重',
                sourceField: 'figure',
                evidence: '60kg 以下',
                confidence: 'high',
              },
              {
                field: '简历附件',
                sourceField: 'hiring_remark',
                evidence: '需上传简历',
                confidence: 'high',
              },
            ],
          },
        }),
      );
      expect(result.isStudent).toBe('仅限学生');
      expect(result.experience).toBe('至少3年餐饮');
      expect(result.householdRegisterProvince).toBe('不要东北籍');
      expect(result.height).toBe('170cm 以上');
      expect(result.weight).toBe('60kg 以下');
      expect(result.resume).toBe('需上传简历');
    });

    it('ignores interview_supplement-sourced signals (those are collected via supplement flow)', () => {
      const result = buildScreeningCriteria(
        makeAnalysis({
          fieldGuidance: {
            ...makeAnalysis().fieldGuidance,
            fieldSignals: [
              {
                field: '是否学生',
                sourceField: 'interview_supplement',
                evidence: '学生信息',
                confidence: 'high',
              },
            ],
          },
        }),
      );
      expect(result.isStudent).toBeUndefined();
    });

    it('emits remark / interviewRemark when present', () => {
      const result = buildScreeningCriteria(
        makeAnalysis({
          normalizedRequirements: {
            ...makeAnalysis().normalizedRequirements,
            remark: '需要会普通话',
            interviewRemark: '请准时',
          },
        }),
      );
      expect(result.remark).toBe('需要会普通话');
      expect(result.interviewRemark).toBe('请准时');
    });

    it('formats slashed evidence with、 ', () => {
      const result = buildScreeningCriteria(
        makeAnalysis({
          normalizedRequirements: {
            ...makeAnalysis().normalizedRequirements,
            educationRequirement: '高中/中专',
          },
        }),
      );
      expect(result.education).toBe('高中、中专');
    });
  });

  describe('buildApiPayloadGuide', () => {
    it('returns required + optional payload fields + fixed jobId / operateType', () => {
      const guide = buildApiPayloadGuide(100, []);
      expect(guide.requiredFields).toContain('jobId');
      expect(guide.requiredFields).toContain('interviewTime');
      expect(guide.fixedValues.jobId).toBe(100);
      expect(typeof guide.fixedValues.operateType).toBe('number');
    });

    it('forwards customerLabelDefinitions verbatim', () => {
      const labels = [{ labelId: 1, labelName: 'demo', name: 'demoLabel' }];
      const guide = buildApiPayloadGuide(200, labels);
      expect(guide.customerLabelDefinitions).toEqual(labels);
    });

    it('emits enumMappings for genderId / hasHealthCertificate / educationId / etc.', () => {
      const guide = buildApiPayloadGuide(300, []);
      expect(guide.enumMappings).toHaveProperty('genderId');
      expect(guide.enumMappings).toHaveProperty('hasHealthCertificate');
      expect(guide.enumMappings).toHaveProperty('healthCertificateTypes');
      expect(guide.enumMappings).toHaveProperty('educationId');
      expect(guide.enumMappings).toHaveProperty('householdRegisterProvinceId');
      expect(guide.enumMappings).toHaveProperty('operateType');
    });
  });
});

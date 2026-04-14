import {
  buildFieldGuidance,
  buildJobPolicyAnalysis,
  cleanPolicyText,
  extractInterviewWindows,
  normalizePolicyText,
  sanitizeConstraintText,
} from '@tools/duliday/job-policy-parser';

describe('job-policy-parser', () => {
  beforeEach(() => {
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should normalize and clean policy text fragments', () => {
    expect(normalizePolicyText('  需要健康证  ')).toBe('需要健康证');
    expect(cleanPolicyText('辛苦跟店长确认。请提前联系\n手动输入')).toBe('请提前联系');
  });

  it('should remove clearly expired date constraints but keep active notes', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T08:00:00.000Z'));

    expect(
      sanitizeConstraintText(
        '最迟1/31面试完毕，2/1最后入职时间，过期不再办理入职，没有健康证的需办加急',
      ),
    ).toBe('没有健康证的需办加急');
  });

  it('should remove stale spring festival constraints after the season', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T02:00:00.000Z'));

    expect(sanitizeConstraintText('周四、六、日需要能给班，过年不返乡，年后返岗')).toBe(
      '周四、六、日需要能给班',
    );
  });

  it('should extract both periodic and fixed interview windows', () => {
    const windows = extractInterviewWindows({
      firstInterview: {
        periodicInterviewTimes: [
          {
            interviewWeekday: '每周一',
            interviewTimes: [
              { interviewStartTime: '09:00', interviewEndTime: '12:00' },
              { interviewStartTime: '14:00', interviewEndTime: '18:00' },
            ],
          },
        ],
        fixedInterviewTimes: [
          {
            interviewDate: '2026-04-08',
            interviewStartTime: '10:00',
            interviewEndTime: '11:00',
          },
        ],
      },
    });

    expect(windows).toEqual([
      { weekday: '每周一', startTime: '09:00', endTime: '12:00' },
      { weekday: '每周一', startTime: '14:00', endTime: '18:00' },
      { date: '2026-04-08', startTime: '10:00', endTime: '11:00' },
    ]);
  });

  it('should extract booking deadlines from the new interview-time contract', () => {
    const windows = extractInterviewWindows({
      firstInterview: {
        periodicInterviewTimes: [
          {
            interviewWeekday: '每周三',
            interviewTimes: [
              {
                interviewStartTime: '13:30',
                interviewEndTime: '16:30',
                cycleDeadlineDay: '前一天',
                cycleDeadlineEnd: '12:00',
              },
            ],
          },
        ],
        fixedInterviewTimes: [
          {
            interviewDate: '2026-04-08',
            interviewTimes: [
              {
                interviewStartTime: '10:00',
                interviewEndTime: '11:00',
                fixedDeadline: '2026-04-07 18:00',
              },
            ],
          },
        ],
      },
    });

    expect(windows).toEqual([
      {
        weekday: '每周三',
        startTime: '13:30',
        endTime: '16:30',
        cycleDeadlineDay: '前一天',
        cycleDeadlineEnd: '12:00',
      },
      {
        date: '2026-04-08',
        startTime: '10:00',
        endTime: '11:00',
        fixedDeadline: '2026-04-07 18:00',
      },
    ]);
  });

  it('should build field guidance from requirements, remarks, figure and supplements', () => {
    const guidance = buildFieldGuidance({
      hiringRequirement: {
        basicPersonalRequirements: {
          minAge: 18,
          maxAge: 35,
          genderRequirement: '女性',
        },
        certificate: {
          education: '高中',
          healthCertificate: '食品健康证',
        },
        remark: '有分拣经验优先，学生慎投，需上传简历，身高170以上',
        figure: '仅限社会人士',
      },
      interviewProcess: {
        interviewSupplement: [
          { interviewSupplement: '请带学历证明' },
          { interviewSupplement: '说明过往公司、岗位和年限' },
          { interviewSupplement: '请补充健康证类型' },
          { interviewSupplement: '请说明户籍省份' },
        ],
      },
    });

    expect(guidance.screeningFields).toEqual(
      expect.arrayContaining([
        '年龄',
        '性别',
        '学历',
        '健康证情况',
        '健康证类型',
        '户籍省份',
        '身高',
        '简历附件',
        '过往公司+岗位+年限',
        '是否学生',
      ]),
    );
    expect(guidance.bookingSubmissionFields).toContain('面试时间');
    expect(guidance.recommendedAskNowFields).toEqual(
      expect.arrayContaining(['姓名', '联系电话', '面试时间']),
    );
    expect(guidance.fieldSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: '年龄', sourceField: 'basic_personal_requirements' }),
        expect.objectContaining({ field: '学历', sourceField: 'certificate' }),
        expect.objectContaining({ field: '是否学生', sourceField: 'figure' }),
        expect.objectContaining({ field: '健康证类型', sourceField: 'interview_supplement' }),
        expect.objectContaining({ field: '身高', sourceField: 'hiring_remark' }),
        expect.objectContaining({ field: '简历附件', sourceField: 'hiring_remark' }),
      ]),
    );
  });

  it('should build normalized analysis with highlights and time hints', () => {
    const analysis = buildJobPolicyAnalysis({
      hiringRequirement: {
        basicPersonalRequirements: {
          minAge: 18,
          maxAge: 40,
          genderRequirement: '男性',
        },
        certificate: {
          education: '大专',
          healthCertificate: '食品健康证',
        },
        remark: '有夜班经验优先，能接受体力活',
      },
      interviewProcess: {
        firstInterview: {
          firstInterviewWay: '线下面试',
          interviewAddress: '上海市杨浦区xx路',
          interviewDemand: '周三下午14:00到店面试',
        },
        interviewSupplement: [{ interviewSupplement: '带健康证原件' }],
        remark: '没有健康证的需办加急，最迟本周完成面试',
      },
    });

    expect(analysis.normalizedRequirements).toEqual(
      expect.objectContaining({
        genderRequirement: '男性',
        ageRequirement: '18-40岁',
        educationRequirement: '大专',
        healthCertificateRequirement: '食品健康证',
      }),
    );
    expect(analysis.interviewMeta).toEqual(
      expect.objectContaining({
        method: '线下面试',
        address: '上海市杨浦区xx路',
        timeHint: '周三下午14:00到店面试',
        registrationDeadlineHint: null,
      }),
    );
    expect(analysis.highlights.requirementHighlights).toContain('有夜班经验优先，能接受体力活');
    expect(analysis.highlights.timingHighlights).toEqual(
      expect.arrayContaining([expect.stringContaining('没有健康证的需办加急')]),
    );
  });

  it('should split interview time hint and registration deadline from mixed interview text', () => {
    const analysis = buildJobPolicyAnalysis({
      interviewProcess: {
        firstInterview: {
          interviewTime:
            '每周都可以安排面试\n周一：13:30 下午-16:30 下午，提交面试名单截止时间为: 当天12:00 中午',
        },
      },
    });

    expect(analysis.interviewMeta.timeHint).toBe('周一：13:30 下午-16:30 下午');
    expect(analysis.interviewMeta.registrationDeadlineHint).toContain('提交面试名单截止时间');
    expect(analysis.interviewMeta.registrationDeadlineHint).toContain('当天12:00 中午');
  });
});

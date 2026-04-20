import { buildInterviewPrecheckTool } from '@tools/duliday-interview-precheck.tool';
import { ToolBuildContext } from '@shared-types/tool.types';

describe('buildInterviewPrecheckTool', () => {
  const mockSpongeService = {
    fetchJobs: jest.fn(),
  };

  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    messages: [],
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const makeJob = (overrides: any = {}) => {
    const {
      basicInfo: basicInfoOverrides = {},
      hiringRequirement: hiringRequirementOverrides = {},
      interviewProcess: interviewProcessOverrides = {},
      ...restOverrides
    } = overrides;
    const { firstInterview: firstInterviewOverrides = {}, ...restInterviewProcessOverrides } =
      interviewProcessOverrides;

    return {
      basicInfo: {
        jobId: 100,
        brandName: 'KFC',
        jobName: '服务员',
        storeInfo: {
          storeName: '五角场店',
        },
        ...basicInfoOverrides,
      },
      hiringRequirement: {
        basicPersonalRequirements: {
          minAge: 18,
          maxAge: 35,
          genderRequirement: '不限',
        },
        certificate: {
          education: '高中',
          healthCertificate: '食品健康证',
        },
        remark: '有餐饮经验优先',
        ...hiringRequirementOverrides,
      },
      interviewProcess: {
        firstInterview: {
          firstInterviewWay: '线下面试',
          interviewAddress: '上海市杨浦区xx路',
          interviewDemand: '请带身份证',
          periodicInterviewTimes: [],
          fixedInterviewTimes: [],
          ...firstInterviewOverrides,
        },
        interviewSupplement: [{ interviewSupplementId: 999, interviewSupplement: '带健康证原件' }],
        remark: '没有健康证的需办加急',
        ...restInterviewProcessOverrides,
      },
      ...restOverrides,
    };
  };

  const executeTool = async (
    input: Record<string, any>,
    contextOverride: Partial<ToolBuildContext> = {},
  ) => {
    const builder = buildInterviewPrecheckTool(mockSpongeService as never);
    const builtTool = builder({
      ...mockContext,
      ...contextOverride,
    });
    return builtTool.execute(input as any, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined as any,
    }) as any;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should reject unsupported requested date strings', async () => {
    const result = await executeTool({ jobId: 100, requestedDate: 'next week' });

    expect(result).toEqual({
      success: false,
      errorType: 'invalid_requested_date',
      error: '无法识别的日期：next week',
    });
  });

  it('should return job_not_found when Sponge returns no matching job', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [] });

    const result = await executeTool({ jobId: 999, requestedDate: '2026-04-08' });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('job_not_found');
    expect(result.error).toContain('jobId=999');
  });

  it('should mark future fixed interview dates as available', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2029-12-01T02:00:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2030-01-01',
                  interviewStartTime: '14:00',
                  interviewEndTime: '16:00',
                },
              ],
            },
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100, requestedDate: '2030-01-01' });

    expect(result.success).toBe(true);
    expect(result.interview.requestedDate).toEqual({
      value: '2030-01-01',
      status: 'available',
      reason: expect.stringContaining('2030-01-01'),
    });
    // stripNullish 会移除空数组/空字符串字段；固定日期窗口在未来没有生成可约示例（因为当前时间较早），
    // 也不会产生周期性 scheduleRule。
    expect(result.interview.upcomingTimeOptions).toBeUndefined();
    expect(result.interview.scheduleRule).toBeUndefined();
    expect(result.nextAction).toBe('collect_fields');
    // 被砍掉的字段不应出现
    expect(result.interview.scheduleWindows).toBeUndefined();
    expect(result.interview.candidateTimeOptions).toBeUndefined();
    expect(result.interview.requestedDateStatus).toBeUndefined();
    expect(result.interview.normalizedRequestedDate).toBeUndefined();
    expect(result.fieldGuidance).toBeUndefined();
    expect(result.policyHighlights).toBeUndefined();
    expect(result.requirements).toBeUndefined();
    expect(result.bookingChecklist.knownFieldMap).toBeUndefined();
    expect(result.bookingChecklist.requiredFields).toEqual(
      expect.arrayContaining([
        '姓名',
        '联系电话',
        '性别',
        '年龄',
        '面试时间',
        '学历',
        '健康证情况',
      ]),
    );
    expect(result.bookingChecklist.displayOrder).toEqual(
      expect.arrayContaining(['姓名', '联系电话', '性别', '年龄', '面试时间']),
    );
    expect(result.bookingChecklist.apiPayloadGuide).toEqual(
      expect.objectContaining({
        requiredFields: expect.arrayContaining([
          'jobId',
          'interviewTime',
          'name',
          'phone',
          'age',
          'genderId',
          'operateType',
        ]),
        optionalFields: expect.arrayContaining([
          'educationId',
          'hasHealthCertificate',
          'healthCertificateTypes',
        ]),
        fixedValues: {
          jobId: 100,
          operateType: 6,
        },
      }),
    );
    expect(result.bookingChecklist.apiPayloadGuide.customerLabelDefinitions).toEqual([
      {
        labelId: 999,
        labelName: '带健康证原件',
        name: '带健康证原件',
      },
    ]);
    // enumHints 应包含缺失字段涉及的枚举
    expect(result.bookingChecklist.enumHints.gender).toEqual(['男', '女']);
    // 健康证首次询问只暴露 有/无 两个选项，避免中间态让候选人困惑；
    // 详见 badcase ub4vrq3v + duliday-interview-precheck.tool.ts 的 HEALTH_CERT_ENUM_HINTS
    expect(result.bookingChecklist.enumHints.healthCertificate).toEqual(['有', '无']);
    expect(result.bookingChecklist.enumHints.education).toContain('高中');
    // screeningCriteria 应包含岗位硬性门槛
    expect(result.screeningCriteria).toEqual(
      expect.objectContaining({
        age: '18-35岁',
        education: '高中',
        healthCertificate: '食品健康证',
      }),
    );
    // 不限性别不应出现
    expect(result.screeningCriteria.gender).toBeUndefined();
    expect(result.bookingChecklist.missingFields).toContain('姓名');
    expect(result.bookingChecklist.missingFields).toContain('带健康证原件');
    expect(result.bookingChecklist.templateText).toContain('姓名：');
    expect(result._fixedReply).toBeUndefined();
    expect(result._replyRule).toBeUndefined();
    expect(result.bookingChecklist.collectionStrategy).toEqual(
      expect.objectContaining({
        candidateResistanceDetected: false,
        recommendedMode: 'full_template',
        starterFields: expect.arrayContaining(['姓名', '联系电话', '性别', '年龄', '面试时间']),
      }),
    );
  });

  it('should compress periodic windows into scheduleRule and generate upcoming options', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z')); // 2026-04-07 10:30 上海时间（周二）
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              periodicInterviewTimes: [
                {
                  interviewWeekday: '每周一',
                  interviewTimes: [
                    {
                      interviewStartTime: '13:30',
                      interviewEndTime: '16:30',
                      cycleDeadlineDay: '当天',
                      cycleDeadlineEnd: '12:00',
                    },
                  ],
                },
                {
                  interviewWeekday: '每周二',
                  interviewTimes: [
                    {
                      interviewStartTime: '13:30',
                      interviewEndTime: '16:30',
                      cycleDeadlineDay: '当天',
                      cycleDeadlineEnd: '12:00',
                    },
                  ],
                },
                {
                  interviewWeekday: '每周三',
                  interviewTimes: [
                    {
                      interviewStartTime: '13:30',
                      interviewEndTime: '16:30',
                      cycleDeadlineDay: '当天',
                      cycleDeadlineEnd: '12:00',
                    },
                  ],
                },
                {
                  interviewWeekday: '每周四',
                  interviewTimes: [
                    {
                      interviewStartTime: '13:30',
                      interviewEndTime: '16:30',
                      cycleDeadlineDay: '当天',
                      cycleDeadlineEnd: '12:00',
                    },
                  ],
                },
                {
                  interviewWeekday: '每周五',
                  interviewTimes: [
                    {
                      interviewStartTime: '13:30',
                      interviewEndTime: '16:30',
                      cycleDeadlineDay: '当天',
                      cycleDeadlineEnd: '12:00',
                    },
                  ],
                },
              ],
              fixedInterviewTimes: [],
            },
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(true);
    expect(result.interview.scheduleRule).toBe('周一至周五 13:30-16:30，当天 12:00 前报名');
    // upcomingTimeOptions 应该覆盖未来 7 天内的周一到周五（今天周二 10:30 还没过 12:00）
    expect(result.interview.upcomingTimeOptions.length).toBeGreaterThanOrEqual(4);
    // 今日那条应带上"今日"标记
    const todayOption = result.interview.upcomingTimeOptions.find((label: string) =>
      label.includes('今日'),
    );
    expect(todayOption).toBeDefined();
    // 未指定 requestedDate 时该字段不应出现
    expect(result.interview.requestedDate).toBeUndefined();
  });

  it('should compress non-consecutive weekdays as list form', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              periodicInterviewTimes: [
                {
                  interviewWeekday: '每周一',
                  interviewTimes: [{ interviewStartTime: '14:00', interviewEndTime: '16:00' }],
                },
                {
                  interviewWeekday: '每周三',
                  interviewTimes: [{ interviewStartTime: '14:00', interviewEndTime: '16:00' }],
                },
                {
                  interviewWeekday: '每周五',
                  interviewTimes: [{ interviewStartTime: '14:00', interviewEndTime: '16:00' }],
                },
              ],
              fixedInterviewTimes: [],
            },
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(true);
    expect(result.interview.scheduleRule).toBe('周一、三、五 14:00-16:00');
  });

  it('should parse 后天 / 本周X / 下周X / 4月12日 to normalized requested dates', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z')); // 2026-04-07 周二
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2026-04-09',
                  interviewStartTime: '13:30',
                  interviewEndTime: '16:30',
                },
                {
                  interviewDate: '2026-04-10',
                  interviewStartTime: '13:30',
                  interviewEndTime: '16:30',
                },
                {
                  interviewDate: '2026-04-15',
                  interviewStartTime: '13:30',
                  interviewEndTime: '16:30',
                },
                {
                  interviewDate: '2026-04-12',
                  interviewStartTime: '13:30',
                  interviewEndTime: '16:30',
                },
              ],
            },
          },
        }),
      ],
    });

    const dayAfterTomorrow = await executeTool({ jobId: 100, requestedDate: '后天' });
    expect(dayAfterTomorrow.interview.requestedDate.value).toBe('2026-04-09');

    const thisWeekFriday = await executeTool({ jobId: 100, requestedDate: '本周五' });
    expect(thisWeekFriday.interview.requestedDate.value).toBe('2026-04-10');

    const nextWeekWednesday = await executeTool({ jobId: 100, requestedDate: '下周三' });
    expect(nextWeekWednesday.interview.requestedDate.value).toBe('2026-04-15');

    const monthDay = await executeTool({ jobId: 100, requestedDate: '4月12日' });
    expect(monthDay.interview.requestedDate.value).toBe('2026-04-12');
  });

  it('should auto-fill known fields into templateText from context', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2026-04-08',
                  interviewStartTime: '13:30',
                  interviewEndTime: '16:30',
                },
              ],
            },
          },
        }),
      ],
    });

    const result = await executeTool(
      { jobId: 100, requestedDate: '2026-04-08' },
      {
        profile: {
          name: '张三',
          phone: '13800138000',
          gender: '男',
          age: '30',
          is_student: false,
          education: '本科',
          has_health_certificate: '有',
        },
        sessionFacts: {
          interview_info: {
            name: '张三',
            phone: '13800138000',
            gender: '男',
            age: '30',
            applied_store: '旧门店',
            applied_position: '旧岗位',
            interview_time: null,
            is_student: false,
            education: '本科',
            has_health_certificate: '有',
          },
          preferences: {
            brands: null,
            salary: null,
            position: null,
            schedule: null,
            city: null,
            district: null,
            location: null,
            labor_form: null,
          },
          reasoning: 'test',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.bookingChecklist.templateText).toContain('姓名：张三');
    expect(result.bookingChecklist.templateText).toContain('联系方式：13800138000');
    expect(result.bookingChecklist.templateText).toContain('面试时间：');
    expect(result.bookingChecklist.templateText).toContain('应聘门店：五角场店');
    expect(result.bookingChecklist.templateText).toContain('应聘岗位：服务员');
    expect(result.bookingChecklist.templateText).not.toContain('应聘门店：旧门店');
    expect(result.bookingChecklist.templateText).not.toContain('应聘岗位：旧岗位');
    expect(result.bookingChecklist.missingFields).toContain('面试时间');
    // 已知字段不应再出现在 missingFields 里
    expect(result.bookingChecklist.missingFields).not.toContain('姓名');
    expect(result.bookingChecklist.missingFields).not.toContain('联系电话');
    // 已知字段涉及的枚举不应再返回；当所有相关枚举均无需提示时，整个 enumHints 会被 stripNullish 移除
    expect(result.bookingChecklist.enumHints).toBeUndefined();
    expect(result.nextAction).toBe('collect_fields');
    expect(result._fixedReply).toBeUndefined();
    expect(result.bookingChecklist.collectionStrategy).toEqual(
      expect.objectContaining({
        candidateResistanceDetected: false,
        recommendedMode: 'full_template',
        starterFields: ['面试时间'],
      }),
    );
  });

  it('should default identity to 社会人士 when age >= 25 (skip is_student question)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2026-04-08',
                  interviewStartTime: '13:30',
                  interviewEndTime: '16:30',
                },
              ],
            },
            interviewSupplement: [{ interviewSupplementId: 501, interviewSupplement: '身份' }],
          },
        }),
      ],
    });

    const result = await executeTool(
      { jobId: 100, requestedDate: '2026-04-08' },
      {
        // 年龄已知 30 岁，is_student 未明确，按派生规则应默认社会人士
        profile: {
          name: null,
          phone: null,
          gender: null,
          age: '30',
          is_student: null,
          education: null,
          has_health_certificate: null,
        },
        sessionFacts: {
          interview_info: { age: '30' },
          preferences: {},
          reasoning: 'test',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.bookingChecklist.missingFields).not.toContain('身份');
    expect(result.bookingChecklist.templateText).toContain('身份：社会人士');
    // 年龄 < 25 的情况下，identity 应仍然缺失 —— 对照用例见下
  });

  it('should still ask identity when age < 25 and is_student unknown', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2026-04-08',
                  interviewStartTime: '13:30',
                  interviewEndTime: '16:30',
                },
              ],
            },
            interviewSupplement: [{ interviewSupplementId: 501, interviewSupplement: '身份' }],
          },
        }),
      ],
    });

    const result = await executeTool(
      { jobId: 100, requestedDate: '2026-04-08' },
      {
        profile: {
          name: null,
          phone: null,
          gender: null,
          age: '20',
          is_student: null,
          education: null,
          has_health_certificate: null,
        },
        sessionFacts: {
          interview_info: { age: '20' },
          preferences: {},
          reasoning: 'test',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.bookingChecklist.missingFields).toContain('身份');
    expect(result.bookingChecklist.enumHints.identity).toEqual(['学生', '社会人士']);
  });

  it('should normalize bare "无" to "无但接受办理健康证" (two-step ask default)', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2026-04-08',
                  interviewStartTime: '13:30',
                  interviewEndTime: '16:30',
                },
              ],
            },
          },
        }),
      ],
    });

    const result = await executeTool(
      { jobId: 100, requestedDate: '2026-04-08' },
      {
        profile: {
          name: null,
          phone: null,
          gender: null,
          age: null,
          is_student: null,
          education: null,
          has_health_certificate: null,
        },
        sessionFacts: {
          interview_info: { has_health_certificate: '无' },
          preferences: {},
          reasoning: 'test',
        },
      },
    );

    expect(result.success).toBe(true);
    // 候选人仅答"无"，现实默认视作"无但接受办理健康证"，不再询问；
    // 仅在候选人主动表达"不接受办理"时才标记为"无且不接受办理健康证"。
    expect(result.bookingChecklist.missingFields).not.toContain('健康证情况');
    expect(result.bookingChecklist.templateText).toContain('健康证：无但接受办理健康证');
  });

  it('should switch to progressive collection guidance when candidate resists filling many fields', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJob()],
    });

    const result = await executeTool(
      { jobId: 100 },
      {
        messages: [
          { role: 'assistant', content: '面试要求：先将以下资料补充下发给我，我来帮你约面试' },
          { role: 'user', content: '滚犊子，这么多信息，太麻烦了' },
        ],
      },
    );

    expect(result.success).toBe(true);
    expect(result.nextAction).toBe('collect_fields');
    expect(result._fixedReply).toBeUndefined();
    expect(result.bookingChecklist.collectionStrategy).toEqual(
      expect.objectContaining({
        candidateResistanceDetected: true,
        recommendedMode: 'progressive',
        matchedSignals: expect.arrayContaining(['滚犊子', '这么多信息', '太麻烦']),
        latestUserMessage: '滚犊子，这么多信息，太麻烦了',
      }),
    );
    expect(result.bookingChecklist.collectionStrategy.starterFields).toEqual(
      expect.arrayContaining(['姓名', '联系电话', '性别', '年龄', '面试时间']),
    );
    expect(result.bookingChecklist.collectionStrategy.reason).toContain('先共情解释');
  });

  it('should render interview template in fixed checklist format with core fields first', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJob()],
    });

    const result = await executeTool({ jobId: 100 });

    const text = result.bookingChecklist.templateText as string;
    expect(text).toContain('面试要求：先将以下资料补充下发给我，我来帮你约面试');

    const idxName = text.indexOf('姓名：');
    const idxPhone = text.indexOf('联系方式：');
    const idxGender = text.indexOf('性别：');
    const idxAge = text.indexOf('年龄：');
    const idxInterviewTime = text.indexOf('面试时间：');
    const idxStore = text.indexOf('应聘门店：');

    expect(idxName).toBeGreaterThan(-1);
    expect(idxPhone).toBeGreaterThan(idxName);
    expect(idxGender).toBeGreaterThan(idxPhone);
    expect(idxAge).toBeGreaterThan(idxGender);
    expect(idxInterviewTime).toBeGreaterThan(idxAge);
    expect(idxStore).toBeGreaterThan(idxInterviewTime);
  });

  it('should expose latest API payload guide and extra collection hints for supplier contract', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          hiringRequirement: {
            remark: '需提供上海户籍、身高170以上、体重不超过70kg，并上传简历',
          },
          interviewProcess: {
            interviewSupplement: [
              { interviewSupplementId: 501, interviewSupplement: '健康证类型' },
              { interviewSupplementId: 502, interviewSupplement: '过往公司+岗位+年限' },
            ],
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(true);
    expect(result.screeningCriteria).toEqual(
      expect.objectContaining({
        householdRegisterProvince: expect.stringContaining('上海户籍'),
        height: expect.stringContaining('身高170以上'),
        weight: expect.stringContaining('体重不超过70kg'),
        resume: expect.stringContaining('上传简历'),
      }),
    );
    expect(result.screeningCriteria.experience).toBeUndefined();
    expect(result.bookingChecklist.missingFields).toEqual(
      expect.arrayContaining([
        '健康证类型',
        '户籍省份',
        '身高',
        '体重',
        '简历附件',
        '过往公司+岗位+年限',
      ]),
    );
    expect(result.bookingChecklist.enumHints.healthCertificateTypes).toEqual([
      '食品健康证',
      '零售健康证',
      '其他健康证',
    ]);
    expect(result.bookingChecklist.enumHints.education).not.toContain('不限');
    expect(result.bookingChecklist.apiPayloadGuide.enumMappings).toEqual(
      expect.objectContaining({
        genderId: expect.objectContaining({ 1: '男', 2: '女' }),
        hasHealthCertificate: expect.objectContaining({ 1: '有', 2: '无但接受办理健康证' }),
        healthCertificateTypes: expect.objectContaining({ 1: '食品健康证' }),
        educationId: expect.objectContaining({ 2: '本科' }),
        operateType: { 6: 'ai导入' },
      }),
    );
    expect(result.bookingChecklist.apiPayloadGuide.enumMappings.educationId[1]).toBeUndefined();
    expect(result.bookingChecklist.customerLabelDefinitions).toEqual([
      { labelId: 501, labelName: '健康证类型', name: '健康证类型' },
      { labelId: 502, labelName: '过往公司+岗位+年限', name: '过往公司+岗位+年限' },
    ]);
  });

  it('should canonicalize overlapping fields and avoid treating pure supplements as screening thresholds', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          hiringRequirement: {
            basicPersonalRequirements: {
              minAge: 18,
              maxAge: 50,
              genderRequirement: '男性,女性',
            },
            certificate: {
              education: '中专\\技校\\职高',
              healthCertificate: '食品健康证',
            },
            remark: null,
          },
          interviewProcess: {
            interviewSupplement: [
              { interviewSupplementId: 4, interviewSupplement: '身高' },
              { interviewSupplementId: 50, interviewSupplement: '体重' },
              { interviewSupplementId: 13, interviewSupplement: '有无健康证' },
              { interviewSupplementId: 3, interviewSupplement: '籍贯' },
              { interviewSupplementId: 320, interviewSupplement: '联系方式' },
            ],
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(true);
    expect(result.screeningCriteria).toEqual(
      expect.objectContaining({
        age: '18-50岁',
        education: '中专、技校、职高',
        healthCertificate: '食品健康证',
      }),
    );
    expect(result.screeningCriteria.gender).toBeUndefined();
    expect(result.screeningCriteria.height).toBeUndefined();
    expect(result.screeningCriteria.weight).toBeUndefined();
    expect(result.screeningCriteria.householdRegisterProvince).toBeUndefined();

    expect(result.bookingChecklist.requiredFields).toEqual(
      expect.arrayContaining([
        '联系电话',
        '健康证情况',
        '户籍省份',
        '身高',
        '体重',
      ]),
    );
    expect(result.bookingChecklist.requiredFields).not.toContain('联系方式');
    expect(result.bookingChecklist.requiredFields).not.toContain('有无健康证');
    expect(result.bookingChecklist.requiredFields).not.toContain('籍贯');
    expect(result.bookingChecklist.missingFields.filter((field: string) => field === '健康证情况')).toHaveLength(1);
    expect(result.bookingChecklist.templateText).toContain('联系方式：');
    expect(result.bookingChecklist.templateText).toContain('籍贯/户籍：');

    expect(result.bookingChecklist.apiPayloadGuide.candidateCollectFields).toBeUndefined();
  });

  it('should mark same-day as unavailable after the latest end time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T11:30:00.000Z')); // 19:30 上海时间
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2026-04-07',
                  interviewStartTime: '09:00',
                  interviewEndTime: '18:00',
                },
              ],
            },
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100, requestedDate: '今天' });

    expect(result.success).toBe(true);
    expect(result.interview.requestedDate).toEqual({
      value: '2026-04-07',
      status: 'unavailable',
      reason: expect.stringContaining('18:00'),
    });
    expect(result.nextAction).toBe('date_unavailable');
    expect(result._fixedReply).toBeUndefined();
  });

  it('should mark same-day as available when now is before earliest window start and deadline not passed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z')); // 10:30 上海时间
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2026-04-07',
                  interviewStartTime: '12:00',
                  interviewEndTime: '17:00',
                },
              ],
            },
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100, requestedDate: 'today' });

    expect(result.success).toBe(true);
    expect(result.interview.requestedDate.status).toBe('available');
    expect(result.interview.requestedDate.reason).toContain('12:00');
  });

  it('should mark same-day as needs_confirmation when now is within an ongoing window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T05:30:00.000Z')); // 13:30 上海时间
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2026-04-07',
                  interviewStartTime: '12:00',
                  interviewEndTime: '17:00',
                },
              ],
            },
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100, requestedDate: 'today' });

    expect(result.success).toBe(true);
    expect(result.interview.requestedDate.status).toBe('needs_confirmation');
  });

  it('should block requested date when fixed booking deadline has passed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T05:00:00.000Z')); // 13:00 上海时间
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2026-04-08',
                  interviewTimes: [
                    {
                      interviewStartTime: '13:30',
                      interviewEndTime: '16:30',
                      fixedDeadline: '2026-04-07 12:00',
                    },
                  ],
                },
              ],
            },
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100, requestedDate: '2026-04-08' });

    expect(result.success).toBe(true);
    expect(result.interview.requestedDate.status).toBe('unavailable');
    expect(result.interview.requestedDate.reason).toContain('报名截止时间');
    expect(result.nextAction).toBe('date_unavailable');
  });

  it('should block requested date when periodic booking deadline has passed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-08T05:00:00.000Z')); // 13:00 上海时间
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              periodicInterviewTimes: [
                {
                  interviewWeekday: '每周三',
                  interviewTimes: [
                    {
                      interviewStartTime: '13:30',
                      interviewEndTime: '16:30',
                      cycleDeadlineDay: '当天',
                      cycleDeadlineEnd: '12:00',
                    },
                  ],
                },
              ],
              fixedInterviewTimes: [],
            },
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100, requestedDate: '2026-04-08' });

    expect(result.success).toBe(true);
    expect(result.interview.requestedDate.status).toBe('unavailable');
    expect(result.interview.requestedDate.reason).toContain('报名截止时间');
  });

  it('should surface Sponge errors as precheck_failed', async () => {
    mockSpongeService.fetchJobs.mockRejectedValue(new Error('API timeout'));

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('precheck_failed');
    expect(result.error).toContain('API timeout');
  });
});

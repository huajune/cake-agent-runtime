import { buildInterviewPrecheckTool } from '@tools/duliday-interview-precheck.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import {
  FALLBACK_EXTRACTION,
  type HighConfidenceFacts,
  type HighConfidenceValue,
} from '@memory/types/session-facts.types';

function highConfidence<T>(value: T, evidence: string): HighConfidenceValue<T> {
  return { value, confidence: 'high', source: 'rule', evidence };
}

function lowConfidence<T>(value: T, evidence: string): HighConfidenceValue<T> {
  return { value, confidence: 'low', source: 'system', evidence };
}

function emptyHighConfidenceFacts(): HighConfidenceFacts {
  return {
    interview_info: {
      name: null,
      phone: null,
      gender: null,
      gender_source: null,
      age: null,
      applied_store: null,
      applied_position: null,
      interview_time: null,
      is_student: null,
      education: null,
      has_health_certificate: null,
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
      delayed_intent: null,
      short_term: null,
      open_position: null,
      time_windows: null,
      schedule_constraint: null,
      available_after: null,
    },
    reasoning: 'test',
  };
}

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
    const builder = buildInterviewPrecheckTool(
      mockSpongeService as never,
      { recordEvent: jest.fn() } as never,
    );
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

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.PRECHECK_INVALID_REQUESTED_DATE);
    expect(result.detailedReason).toBe('无法识别的日期：next week');
  });

  it('should return job_not_found when Sponge returns no matching job', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [] });

    const result = await executeTool({ jobId: 999, requestedDate: '2026-04-08' });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.PRECHECK_JOB_NOT_FOUND);
    expect(result.detailedReason).toContain('jobId=999');
  });

  describe('jobId provenance 闸门', () => {
    it('jobId 不在本会话召回集时拦截幻觉，不打 Sponge 接口', async () => {
      // 空会话约面意向幻觉簇：候选人只发"应聘"，模型凭空编出 jobId + 候选人报名表
      const result = await executeTool(
        { jobId: 3545431, candidateName: '王宇', candidatePhone: '13513516745' },
        { isRecalledJobId: () => false },
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.PRECHECK_JOB_NOT_PROVIDED);
      // 闸门必须在打 Sponge 之前短路，避免走 job_not_found 让模型脑补"岗位下架了"
      expect(mockSpongeService.fetchJobs).not.toHaveBeenCalled();
    });

    it('召回过 A 岗位但传入未召回的 B 岗位 jobId 时仍拦截（成员判定，非"召回过任意岗位"）', async () => {
      // P0：模型召回 A 后另编一个恰好真实的 B 岗位 jobId 绕过——成员判定必须拦住
      const recalled = new Set<number>([528339]); // 仅召回过 A=528339
      const result = await executeTool(
        { jobId: 999001, requestedDate: '2026-04-08' }, // B=999001 不在召回集
        { isRecalledJobId: (id: number) => recalled.has(id) },
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.PRECHECK_JOB_NOT_PROVIDED);
      expect(mockSpongeService.fetchJobs).not.toHaveBeenCalled();
    });

    it('jobId 命中本会话召回集时放行（自救闭环：先 job_list 再 precheck）', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [] });

      const result = await executeTool(
        { jobId: 528339, requestedDate: '2026-04-08' },
        { isRecalledJobId: (id: number) => id === 528339 },
      );

      // 放行后落到既有 fetchJobs 路径
      expect(mockSpongeService.fetchJobs).toHaveBeenCalledTimes(1);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.PRECHECK_JOB_NOT_FOUND);
    });

    it('未注入 isRecalledJobId（test/debug 链路）时跳过闸门，向后兼容', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [] });

      const result = await executeTool({ jobId: 528339, requestedDate: '2026-04-08' });

      expect(mockSpongeService.fetchJobs).toHaveBeenCalledTimes(1);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.PRECHECK_JOB_NOT_FOUND);
    });
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
            ...FALLBACK_EXTRACTION.preferences,
            brands: null,
            salary: null,
            position: null,
            schedule: null,
            city: null,
            district: null,
            location: null,
            labor_form: null,
            delayed_intent: null,
            short_term: null,
            open_position: null,
            time_windows: null,
            schedule_constraint: null,
            available_after: null,
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

  it('should use candidateAge input as the current turn source of truth', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          hiringRequirement: {
            basicPersonalRequirements: {
              minAge: 25,
              maxAge: 50,
              genderRequirement: '男性',
            },
            remark: '',
          },
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
            interviewSupplement: [],
          },
        }),
      ],
    });

    const result = await executeTool(
      {
        jobId: 100,
        requestedDate: '2026-04-08',
        candidateAge: 24,
      },
      {
        sessionFacts: {
          interview_info: {
            ...FALLBACK_EXTRACTION.interview_info,
            age: '30',
            education: null,
            has_health_certificate: null,
          },
          preferences: FALLBACK_EXTRACTION.preferences,
          reasoning: 'stale context',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.ageBoundary).toEqual(
      expect.objectContaining({
        candidateAge: 24,
        requiredMin: 25,
        requiredMax: 50,
        side: 'under_min',
        severity: 'boundary',
      }),
    );
    expect(result.bookingChecklist.templateText).toContain('年龄：24');
    expect(result.bookingChecklist.templateText).not.toContain('年龄：30');
  });

  it('should use explicit candidate fields as the current turn source of truth', async () => {
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
            interviewSupplement: [],
          },
        }),
      ],
    });

    const result = await executeTool(
      {
        jobId: 100,
        requestedDate: '2026-04-08',
        candidateAge: 24,
        candidateInterviewTime: '明天吧',
        candidateGender: '女',
        candidateEducation: '大专',
        candidateHasHealthCertificate: '有',
        candidateIsStudent: true,
      },
      {
        sessionFacts: {
          interview_info: {
            ...FALLBACK_EXTRACTION.interview_info,
            age: '30',
            gender: '男',
            interview_time: '后天',
            education: '高中',
            has_health_certificate: '无',
            is_student: false,
          },
          preferences: FALLBACK_EXTRACTION.preferences,
          reasoning: 'stale context',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.bookingChecklist.templateText).toContain('性别：女');
    expect(result.bookingChecklist.templateText).toContain('年龄：24');
    expect(result.bookingChecklist.templateText).toContain('面试时间：明天吧');
    expect(result.bookingChecklist.templateText).toContain('学历：大专');
    expect(result.bookingChecklist.templateText).toContain('健康证：有');
    expect(result.bookingChecklist.templateText).toContain('身份（学生/社会人士）：学生');
    expect(result.bookingChecklist.templateText).not.toContain('性别：男');
    expect(result.bookingChecklist.templateText).not.toContain('年龄：30');
    expect(result.bookingChecklist.templateText).not.toContain('面试时间：后天');
    expect(result.bookingChecklist.missingFields).not.toContain('性别');
    expect(result.bookingChecklist.missingFields).not.toContain('年龄');
    expect(result.bookingChecklist.missingFields).not.toContain('面试时间');
  });

  it('should backfill 姓名/联系电话 from candidateName/candidatePhone when session facts are empty (跨天回访旧事实已过期)', async () => {
    // 复刻王乐泉 case：候选人跨天回访，Redis 会话事实里姓名/电话已过期，
    // 但本轮对话原文里 Agent 已重新收齐。姓名/电话没有专属 candidate* 入参时，
    // buildKnownFieldMap 读不到 → 永远留在 missingFields → nextAction 卡死 collect_fields
    // → Agent 反复让候选人"回复确认"。candidateName/candidatePhone 提供唯一回灌通道。
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          // 清掉"有餐饮经验优先"，避免引入额外的"过往公司+岗位+年限"收集字段，便于断言 missingFields 收齐为空
          hiringRequirement: { remark: '' },
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
            interviewSupplement: [],
          },
        }),
      ],
    });

    const result = await executeTool({
      jobId: 100,
      requestedDate: '2026-04-08',
      candidateName: '王乐泉',
      candidatePhone: '13467029824',
      candidateAge: 23,
      candidateInterviewTime: '后天下午',
      candidateGender: '男',
      candidateEducation: '大专',
      candidateHasHealthCertificate: '有',
      // 关键：LLM 把 is_student 当 boolean 传成字符串 "false"
      candidateIsStudent: 'false',
    });

    expect(result.success).toBe(true);
    expect(result.bookingChecklist.missingFields ?? []).not.toContain('姓名');
    expect(result.bookingChecklist.missingFields ?? []).not.toContain('联系电话');
    expect(result.bookingChecklist.missingFields ?? []).not.toContain('身份');
    expect(result.bookingChecklist.missingFields ?? []).toEqual([]);
    expect(result.nextAction).toBe('ready_to_book');
    expect(result.bookingChecklist.templateText).toContain('王乐泉');
    expect(result.bookingChecklist.templateText).toContain('13467029824');
    expect(result.bookingChecklist.templateText).toContain('身份（学生/社会人士）：社会人士');
  });

  it('should treat 审简历优先 jobs as wait_notice even when interview windows exist (不判 date_unavailable)', async () => {
    // badcase chat 6a2fac72…：奥乐齐岗位虽配了面试时段窗口，但 interviewAddress 是
    // "先审核简历，待简历审核通过后，告知面试地点&时间"——面试时间由面试官在简历审核
    // 通过后另行通知。候选人给的"明天"被当普通岗位校验成 date_unavailable，导致 Agent
    // 口头说"已递交审核"却始终没真正调 booking。修复后应识别为 wait_notice：不评估
    // requestedDate、不收"面试时间"、资料齐即 ready_to_book。
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T02:30:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          hiringRequirement: { remark: '' },
          interviewProcess: {
            firstInterview: {
              interviewAddress: '先审核简历，待简历审核通过后，告知面试地点&时间',
              // 岗位确实配了面试时段窗口（仅 6-09，不含候选人请求的"明天"=6-16）
              fixedInterviewTimes: [
                {
                  interviewDate: '2026-06-09',
                  interviewStartTime: '13:00',
                  interviewEndTime: '18:00',
                },
              ],
            },
            interviewSupplement: [],
          },
        }),
      ],
    });

    const result = await executeTool({
      jobId: 100,
      requestedDate: '明天',
      candidateName: '徐中如',
      candidatePhone: '15105174081',
      candidateAge: 28,
      candidateInterviewTime: '明天',
      candidateGender: '女',
      candidateEducation: '高中',
      candidateHasHealthCertificate: '无',
      candidateIsStudent: 'false',
    });

    expect(result.success).toBe(true);
    expect(result.interview.interviewTimeMode).toBe('wait_notice');
    // 不评估 requestedDate（resume-review-first → requestedDateCheck=null，被 stripNullish 去掉）
    expect(result.interview.requestedDate ?? null).toBeNull();
    // 既不判 date_unavailable，也不收"面试时间"，资料齐即可直接 booking
    expect(result.nextAction).toBe('ready_to_book');
    expect(result.bookingChecklist.missingFields ?? []).not.toContain('面试时间');
  });

  it('should map candidateIsStudent boolean-like strings to 身份', async () => {
    // LLM 常把 is_student 当 boolean 传成字符串 "true"/"false"，归一化必须识别这些值，
    // 否则"身份"永远留在 missingFields、nextAction 卡死 collect_fields。
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));

    for (const [input, expected] of [
      ['false', '社会人士'],
      ['False', '社会人士'],
      ['true', '学生'],
      ['True', '学生'],
    ] as const) {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [makeJob({ interviewProcess: { interviewSupplement: [] } })],
      });
      const result = await executeTool({ jobId: 100, candidateIsStudent: input });
      expect(result.success).toBe(true);
      // 归一化成功 → 身份被回灌进 knownFieldMap，模板按已知值渲染，且不会落入 missingFields
      expect(result.bookingChecklist.missingFields ?? []).not.toContain('身份');
      expect(result.bookingChecklist.templateText).toContain(`身份（学生/社会人士）：${expected}`);
    }
  });

  it('should collect only missing education when candidate passes age boundary with explicit fields', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-27T02:30:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          basicInfo: { jobId: 523067 },
          hiringRequirement: {
            basicPersonalRequirements: {
              minAge: 25,
              maxAge: 50,
              genderRequirement: '不限',
            },
            certificate: {
              education: '高中',
              healthCertificate: '食品健康证',
            },
            remark: '',
          },
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2026-05-28',
                  interviewStartTime: '13:30',
                  interviewEndTime: '16:30',
                },
              ],
            },
            interviewSupplement: [],
          },
        }),
      ],
    });

    const result = await executeTool(
      {
        jobId: 523067,
        requestedDate: '2026-05-28',
        candidateAge: 24,
        candidateInterviewTime: '明天吧',
        candidateHasHealthCertificate: '有',
      },
      {
        sessionFacts: {
          interview_info: {
            ...FALLBACK_EXTRACTION.interview_info,
            name: '张三',
            phone: '13800138000',
            gender: '女',
            education: null,
          },
          preferences: FALLBACK_EXTRACTION.preferences,
          reasoning: 'candidate has provided name, phone and gender',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.nextAction).toBe('collect_fields');
    expect(result.ageBoundary).toEqual(
      expect.objectContaining({
        candidateAge: 24,
        requiredMin: 25,
        requiredMax: 50,
        side: 'under_min',
        severity: 'boundary',
      }),
    );
    expect(result.bookingChecklist.missingFields).toEqual(['学历']);
    expect(result.bookingChecklist.templateText).toContain('姓名：张三');
    expect(result.bookingChecklist.templateText).toContain('联系方式：13800138000');
    expect(result.bookingChecklist.templateText).toContain('年龄：24');
    expect(result.bookingChecklist.templateText).toContain('面试时间：明天吧');
    expect(result.bookingChecklist.templateText).toContain('健康证：有');
    expect(result.bookingChecklist.templateText).toContain('学历：');
  });

  it('should use high-confidence highConfidenceFacts age before stale session facts', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          hiringRequirement: {
            basicPersonalRequirements: {
              minAge: 25,
              maxAge: 50,
              genderRequirement: '男性',
            },
            remark: '',
          },
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
            interviewSupplement: [],
          },
        }),
      ],
    });

    const result = await executeTool(
      {
        jobId: 100,
        requestedDate: '2026-04-08',
      },
      {
        sessionFacts: {
          interview_info: {
            ...FALLBACK_EXTRACTION.interview_info,
            age: '30',
          },
          preferences: FALLBACK_EXTRACTION.preferences,
          reasoning: 'stale context',
        },
        highConfidenceFacts: {
          ...emptyHighConfidenceFacts(),
          interview_info: {
            ...emptyHighConfidenceFacts().interview_info,
            age: highConfidence('24', '年龄识别：24'),
          },
          reasoning: '年龄识别：24',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.ageBoundary).toEqual(
      expect.objectContaining({
        candidateAge: 24,
        requiredMin: 25,
        requiredMax: 50,
        side: 'under_min',
        severity: 'boundary',
      }),
    );
    expect(result.bookingChecklist.templateText).toContain('年龄：24');
    expect(result.bookingChecklist.templateText).not.toContain('年龄：30');
  });

  it('should ignore low-confidence highConfidenceFacts age for ageBoundary and checklist prefill', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          hiringRequirement: {
            basicPersonalRequirements: {
              minAge: 25,
              maxAge: 50,
              genderRequirement: '男性',
            },
            remark: '',
          },
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
            interviewSupplement: [],
          },
        }),
      ],
    });

    const result = await executeTool(
      {
        jobId: 100,
        requestedDate: '2026-04-08',
      },
      {
        sessionFacts: FALLBACK_EXTRACTION,
        highConfidenceFacts: {
          ...emptyHighConfidenceFacts(),
          interview_info: {
            ...emptyHighConfidenceFacts().interview_info,
            age: lowConfidence('24', '低置信年龄'),
          },
          reasoning: '低置信年龄',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.ageBoundary).toEqual(
      expect.objectContaining({
        requiredMin: 25,
        requiredMax: 50,
        severity: 'unknown',
      }),
    );
    expect(result.ageBoundary).not.toHaveProperty('candidateAge');
    expect(result.bookingChecklist.templateText).toContain('年龄：');
    expect(result.bookingChecklist.templateText).not.toContain('年龄：24');
    expect(result.bookingChecklist.missingFields).toContain('年龄');
  });

  it('should not prefill manager name as candidate name (badcase m5lpfwi0)', async () => {
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
        botUserId: '李涵婷',
        sessionFacts: {
          interview_info: {
            ...FALLBACK_EXTRACTION.interview_info,
            name: '李涵婷',
            phone: '13800138000',
            gender: '男',
            age: '37',
            interview_time: '2026-04-08',
          },
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
          },
          reasoning: 'badcase m5lpfwi0: quoted manager name was extracted as candidate name',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.nameFieldGuard).toEqual(
      expect.objectContaining({
        suspicious: true,
        observedValue: '李涵婷',
      }),
    );
    expect(result.nameFieldGuard.reason).toContain('招募经理');
    expect(result.bookingChecklist.missingFields).toContain('姓名');
    expect(result.bookingChecklist.templateText).toContain('姓名：');
    expect(result.bookingChecklist.templateText).not.toContain('姓名：李涵婷');
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
          preferences: FALLBACK_EXTRACTION.preferences,
          reasoning: 'test',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.bookingChecklist.missingFields).not.toContain('身份');
    // 字段名带括号消歧（badcase bi6ewy2w：候选人误把"身份"理解成身份证号）
    expect(result.bookingChecklist.templateText).toContain('身份（学生/社会人士）：社会人士');
    // 年龄 < 25 的情况下，identity 应仍然缺失 —— 对照用例见下
  });

  it('should clear collect-type supplement labels from missingFields when candidate已答 are passed via candidateSupplementAnswers', async () => {
    // 复现 badcase（chat 6a27d9fe…）：collect 型 supplement label 进了 requiredFields，
    // 但既无专属 candidate* 入参、buildKnownFieldMap 也不映射，候选人即便答了也永远卡在
    // missingFields → nextAction 永远 collect_fields → booking 闸门永远拒 → handoff。
    const buildJobWithCollectLabels = () =>
      makeJob({
        // 清掉默认 remark "有餐饮经验优先"，避免引入"过往公司+岗位+年限"干扰本用例断言
        hiringRequirement: { remark: '' },
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
          interviewSupplement: [
            { interviewSupplementId: 57, interviewSupplement: '居住地址' },
            { interviewSupplementId: 207, interviewSupplement: '意向区域' },
          ],
        },
      });
    const knownStandardFields = {
      profile: {
        name: '惠梓航',
        phone: '13800138000',
        gender: '男',
        age: '22',
        is_student: false,
        education: '本科',
        has_health_certificate: '有',
      },
      sessionFacts: {
        interview_info: {
          name: '惠梓航',
          phone: '13800138000',
          gender: '男',
          age: '22',
          education: '本科',
          has_health_certificate: '有',
          interview_time: '2026-04-08 13:30:00',
        },
        preferences: FALLBACK_EXTRACTION.preferences,
        reasoning: 'test',
      },
    };

    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));

    // 不传 candidateSupplementAnswers：居住地址/意向区域 仍滞留 missingFields
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [buildJobWithCollectLabels()] });
    const without = await executeTool(
      { jobId: 100, requestedDate: '2026-04-08' },
      knownStandardFields,
    );
    expect(without.bookingChecklist.missingFields).toContain('居住地址');
    expect(without.bookingChecklist.missingFields).toContain('意向区域');

    // 传入候选人已答的 supplement label：两者从 missingFields 清除，达成 ready_to_book
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [buildJobWithCollectLabels()] });
    const withAnswers = await executeTool(
      {
        jobId: 100,
        requestedDate: '2026-04-08',
        candidateSupplementAnswers: { 居住地址: '南京信息工程大学', 意向区域: '浦口' },
      },
      knownStandardFields,
    );
    // missingFields 收齐后为空数组，会被 stripNullish 剔除（key 不再存在）
    const remaining = withAnswers.bookingChecklist?.missingFields ?? [];
    expect(remaining).not.toContain('居住地址');
    expect(remaining).not.toContain('意向区域');
    expect(remaining).toEqual([]);
    expect(withAnswers.nextAction).toBe('ready_to_book');
  });

  it('should clear 工作经历 label even when answered under the checklist display name (近一段工作经历 ⇄ 过往公司+岗位+年限)', async () => {
    // badcase chat 6a2fac72…：岗位后台 label 名为"近一段工作经历"，但 precheck 把它归一成
    // checklist 显示名"过往公司+岗位+年限"，Agent 按显示名回答。两端名字不同 →
    // getSupplementAnswerValue 取不到 → 字段一直滞留 missingFields、卡死 collect_fields。
    const buildJob = () =>
      makeJob({
        hiringRequirement: { remark: '' },
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
          interviewSupplement: [
            { interviewSupplementId: 130, interviewSupplement: '近一段工作经历' },
          ],
        },
      });
    const knownStandardFields = {
      profile: {
        name: '徐中如',
        phone: '15105174081',
        gender: '女',
        age: '28',
        is_student: false,
        education: '高中',
        has_health_certificate: '有',
      },
      sessionFacts: {
        interview_info: {
          name: '徐中如',
          phone: '15105174081',
          gender: '女',
          age: '28',
          education: '高中',
          has_health_certificate: '有',
          interview_time: '2026-04-08 13:30:00',
        },
        preferences: FALLBACK_EXTRACTION.preferences,
        reasoning: 'test',
      },
    };

    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));

    // 不传答案：工作经历 字段（显示名 过往公司+岗位+年限）滞留 missingFields
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [buildJob()] });
    const without = await executeTool(
      { jobId: 100, requestedDate: '2026-04-08' },
      knownStandardFields,
    );
    expect(without.bookingChecklist.missingFields).toContain('过往公司+岗位+年限');

    // 候选人用 checklist 显示名回答（而非 label 原名）：别名桥接后应清除
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [buildJob()] });
    const withAnswers = await executeTool(
      {
        jobId: 100,
        requestedDate: '2026-04-08',
        candidateSupplementAnswers: { '过往公司+岗位+年限': '良品铺子 店长3年/销售经理主管' },
      },
      knownStandardFields,
    );
    const remaining = withAnswers.bookingChecklist?.missingFields ?? [];
    expect(remaining).not.toContain('过往公司+岗位+年限');
    expect(remaining).toEqual([]);
    expect(withAnswers.nextAction).toBe('ready_to_book');
  });

  it('should keep ambiguous gender text unfilled instead of coercing it to 女', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJob()],
    });

    const result = await executeTool(
      { jobId: 100 },
      {
        profile: {
          name: '张三',
          phone: '13800138000',
          gender: '男女不限',
          age: null,
          is_student: null,
          education: null,
          has_health_certificate: null,
        },
        sessionFacts: {
          interview_info: {
            name: '张三',
            phone: '13800138000',
            gender: '男女不限',
          },
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            brands: null,
            salary: null,
            position: null,
            schedule: null,
            city: null,
            district: null,
            location: null,
            labor_form: null,
            delayed_intent: null,
            short_term: null,
            open_position: null,
            time_windows: null,
            schedule_constraint: null,
            available_after: null,
          },
          reasoning: 'test',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.bookingChecklist.templateText).toContain('性别：');
    expect(result.bookingChecklist.templateText).not.toContain('性别：女');
    expect(result.bookingChecklist.templateText).not.toContain('性别：男女不限');
    expect(result.bookingChecklist.missingFields).toContain('性别');
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
          preferences: FALLBACK_EXTRACTION.preferences,
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
          preferences: FALLBACK_EXTRACTION.preferences,
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

  it('should not treat non-local health certificate as a completed certificate answer', async () => {
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
        sessionFacts: {
          interview_info: { has_health_certificate: '非本地健康证' },
          preferences: FALLBACK_EXTRACTION.preferences,
          reasoning: 'test',
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.bookingChecklist.missingFields).toContain('健康证情况');
    expect(result.bookingChecklist.templateText).toContain('健康证：');
  });

  it('should switch to progressive collection guidance when candidate resists filling many fields', async () => {
    // 配上面试窗口：无窗口岗位走 wait_notice 模式不收"面试时间"，会干扰本用例对
    // starterFields 完整骨架的断言
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2099-04-08',
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
    // 配上面试窗口：无窗口岗位走 wait_notice 模式，模板不再包含"面试时间"行
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2099-04-08',
                  interviewStartTime: '13:30',
                  interviewEndTime: '16:30',
                },
              ],
            },
          },
        }),
      ],
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
    expect(result.bookingChecklist.requiredFields).toContain('简历附件');
    expect(result.bookingChecklist.requiredFields).not.toContain('上传简历');
    expect(result.bookingChecklist.templateText).toContain('简历附件：');
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
      expect.arrayContaining(['联系电话', '健康证情况', '户籍省份', '身高', '体重']),
    );
    expect(result.bookingChecklist.requiredFields).not.toContain('联系方式');
    expect(result.bookingChecklist.requiredFields).not.toContain('有无健康证');
    expect(result.bookingChecklist.requiredFields).not.toContain('籍贯');
    expect(
      result.bookingChecklist.missingFields.filter((field: string) => field === '健康证情况'),
    ).toHaveLength(1);
    expect(result.bookingChecklist.templateText).toContain('联系方式：');
    expect(result.bookingChecklist.templateText).toContain('籍贯/户籍：');

    expect(result.bookingChecklist.apiPayloadGuide.candidateCollectFields).toBeUndefined();
  });

  it('should route screening-style supplement labels out of templateText into screeningChecks', async () => {
    // 回归 badcase batch_69e9bba2536c9654026522da_*：岗位 527385 的四个 supplement
    // label 带括号约束/反问式语义，之前被当成收集项原样塞进 templateText，Agent 把
    // 候选人答案（"食品类"/"不一定"）当合格结果提交了 duliday_interview_booking。
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            interviewSupplement: [
              { interviewSupplementId: 661, interviewSupplement: '一周能上几天班' },
              {
                interviewSupplementId: 660,
                interviewSupplement: '是否学生（不要学生）',
              },
              { interviewSupplementId: 659, interviewSupplement: '专业（非新媒、食品）' },
              { interviewSupplementId: 668, interviewSupplement: '周四六日都能上班吗' },
              { interviewSupplementId: 564, interviewSupplement: '能干几个月' },
            ],
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(true);
    // 收集型 label 仍然进模板
    expect(result.bookingChecklist.templateText).toContain('一周能上几天班：');
    expect(result.bookingChecklist.templateText).toContain('能干几个月：');
    // 筛选型 label 必须被踢出 templateText / requiredFields / missingFields
    expect(result.bookingChecklist.templateText).not.toContain('是否学生（不要学生）');
    expect(result.bookingChecklist.templateText).not.toContain('专业（非新媒、食品）');
    expect(result.bookingChecklist.templateText).not.toContain('周四六日都能上班吗');
    expect(result.bookingChecklist.requiredFields).not.toEqual(
      expect.arrayContaining([
        '是否学生（不要学生）',
        '专业（非新媒、食品）',
        '周四六日都能上班吗',
      ]),
    );
    // 但 customerLabelDefinitions 仍包含全量定义，booking 工具需要 labelId 做 payload 回填
    expect(result.bookingChecklist.customerLabelDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ labelName: '是否学生（不要学生）' }),
        expect.objectContaining({ labelName: '专业（非新媒、食品）' }),
        expect.objectContaining({ labelName: '周四六日都能上班吗' }),
      ]),
    );
    // 筛选题单独出口，带上 labelId / mode / failSignals
    expect(result.screeningChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labelName: '是否学生（不要学生）',
          mode: 'blacklist',
          failSignals: expect.arrayContaining(['学生']),
        }),
        expect.objectContaining({
          labelName: '专业（非新媒、食品）',
          mode: 'blacklist',
          failSignals: expect.arrayContaining(['新媒', '食品']),
        }),
        expect.objectContaining({
          labelName: '周四六日都能上班吗',
          mode: 'rhetorical',
          failSignals: expect.arrayContaining(['不一定', '不能']),
        }),
      ]),
    );
  });

  it('should omit screeningChecks when all supplement labels are collect-type', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            interviewSupplement: [
              { interviewSupplementId: 1, interviewSupplement: '学历' },
              { interviewSupplementId: 2, interviewSupplement: '能干几个月' },
            ],
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(true);
    expect(result.screeningChecks).toBeUndefined();
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

  it('should expose 00:00-00:00 windows as date-only slots that cannot be auto-booked', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-28T03:30:00.000Z')); // 11:30 上海时间
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              periodicInterviewTimes: [
                {
                  interviewWeekday: '每周四',
                  interviewTimes: [
                    {
                      interviewStartTime: '00:00',
                      interviewEndTime: '00:00',
                      cycleDeadlineDay: '当天',
                      cycleDeadlineEnd: '10:00',
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

    const result = await executeTool({ jobId: 100, requestedDate: '2026-04-30' });

    expect(result.success).toBe(true);
    expect(result.interview.requestedDate).toEqual({
      value: '2026-04-30',
      status: 'available',
      reason: expect.stringContaining('2026-04-30'),
    });
    expect(result.interview.upcomingTimeOptions).toContain(
      '2026-04-30 周四 00:00-00:00（报名截止 2026-04-30 10:00）',
    );
    expect(result.interview.bookableSlots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          date: '2026-04-30',
          weekday: '周四',
          startTime: '00:00',
          endTime: '00:00',
          registrationDeadline: '2026-04-30 10:00',
          dateOnly: true,
          bookingAllowed: false,
          requiresManualConfirmation: true,
        }),
      ]),
    );
    const requestedSlot = result.interview.bookableSlots.find(
      (slot: Record<string, unknown>) => slot.date === '2026-04-30',
    );
    expect(requestedSlot.interviewTime).toBeUndefined();
    expect(requestedSlot.reason).toContain('不要自动调用预约工具');
  });

  it('should normalize bookable slot interviewTime to the booking tool format', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-28T03:30:00.000Z')); // 11:30 上海时间
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              fixedInterviewTimes: [
                {
                  interviewDate: '2026-04-30',
                  interviewTimes: [
                    {
                      interviewStartTime: '9:30',
                      interviewEndTime: '10:30',
                    },
                  ],
                },
              ],
            },
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100, requestedDate: '2026-04-30' });

    expect(result.success).toBe(true);
    const requestedSlot = result.interview.bookableSlots.find(
      (slot: Record<string, unknown>) => slot.date === '2026-04-30',
    );
    expect(requestedSlot).toEqual(
      expect.objectContaining({
        dateOnly: false,
        bookingAllowed: true,
        interviewTime: '2026-04-30 09:30:00',
      }),
    );
  });

  it('should surface Sponge errors as precheck_failed', async () => {
    mockSpongeService.fetchJobs.mockRejectedValue(new Error('API timeout'));

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.PRECHECK_FAILED);
    expect(result.reason).toBe('API timeout');
    expect(result._replyInstruction).not.toContain('API timeout');
  });

  describe('wait_notice（岗位未配置面试时段，平台预约时间=等待通知）', () => {
    // badcase：必胜客央视新店电话面试岗——岗位没有任何面试时段，候选人给出日期后
    // precheck 判 date_unavailable，整条预约链卡死、Agent 被迫转人工。
    // 平台已支持这类岗位不选时间提交（由面试官电话联系），precheck 应走 wait_notice 模式。
    it('should not return date_unavailable for jobs without interview windows even when requestedDate is given', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] }); // 默认 makeJob 无任何窗口

      const result = await executeTool({ jobId: 100, requestedDate: '2026-04-11' });

      expect(result.success).toBe(true);
      expect(result.nextAction).toBe('collect_fields');
      expect(result.interview.interviewTimeMode).toBe('wait_notice');
      expect(result.interview.interviewTimeModeNote).toContain('面试官');
      // 不评估 requestedDate：没有日期可对齐，也不能判 unavailable
      expect(result.interview.requestedDate).toBeUndefined();
      // "面试时间"不进收资清单与模板
      expect(result.bookingChecklist.requiredFields).not.toContain('面试时间');
      expect(result.bookingChecklist.displayOrder).not.toContain('面试时间');
      expect(result.bookingChecklist.missingFields).not.toContain('面试时间');
      expect(result.bookingChecklist.templateText).not.toContain('面试时间：');
      // booking 契约指引同步剔除 interviewTime
      expect(result.bookingChecklist.apiPayloadGuide.requiredFields).not.toContain('interviewTime');
      expect(result.bookingChecklist.apiPayloadGuide.requiredFields).toContain('name');
    });

    it('should reach ready_to_book without interview time once other fields are collected', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJob({
            // 清掉 remark / supplement，避免"过往公司+岗位+年限"与 collect 标签干扰断言
            hiringRequirement: { remark: '' },
            interviewProcess: { interviewSupplement: [] },
          }),
        ],
      });

      const result = await executeTool(
        { jobId: 100 },
        {
          profile: {
            name: '张三',
            phone: '13800138000',
            gender: '男',
            age: '22',
            is_student: false,
            education: '本科',
            has_health_certificate: '有',
          },
          sessionFacts: {
            interview_info: {
              name: '张三',
              phone: '13800138000',
              gender: '男',
              age: '22',
              education: '本科',
              has_health_certificate: '有',
            },
            preferences: FALLBACK_EXTRACTION.preferences,
            reasoning: 'test',
          },
        },
      );

      expect(result.success).toBe(true);
      expect(result.bookingChecklist?.missingFields ?? []).toEqual([]);
      // 无窗口岗位不需要 confirm_date：字段收齐即 ready_to_book
      expect(result.nextAction).toBe('ready_to_book');
      expect(result.interview.interviewTimeMode).toBe('wait_notice');
    });
  });
});

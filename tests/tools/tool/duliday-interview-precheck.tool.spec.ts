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
  const makeJob = (overrides: any = {}) => ({
    basicInfo: {
      jobId: 100,
      brandName: 'KFC',
      jobName: '服务员',
      storeInfo: {
        storeName: '五角场店',
      },
      ...overrides.basicInfo,
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
      ...overrides.hiringRequirement,
    },
    interviewProcess: {
      firstInterview: {
        firstInterviewWay: '线下面试',
        interviewAddress: '上海市杨浦区xx路',
        interviewDemand: '请带身份证',
        periodicInterviewTimes: [],
        fixedInterviewTimes: [],
        ...overrides.interviewProcess?.firstInterview,
      },
      interviewSupplement: [{ interviewSupplement: '带健康证原件' }],
      remark: '没有健康证的需办加急',
      ...overrides.interviewProcess,
    },
    ...overrides,
  });

  const executeTool = async (input: Record<string, any>, contextOverride: Partial<ToolBuildContext> = {}) => {
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
    expect(result.interview.requestedDateStatus).toBe('available');
    expect(result.interview.canScheduleOnRequestedDate).toBe(true);
    expect(result.interview.requestedDateDecisionBasis).toBe('future_schedule_match');
    expect(result.interview.requestedDateMatchedWindows).toEqual([
      expect.objectContaining({ date: '2030-01-01', startTime: '14:00', endTime: '16:00' }),
    ]);
    expect(result.interview.normalizedRequestedDate).toBe('2030-01-01');
    expect(result.interview.candidateTimeOptions).toEqual([
      expect.objectContaining({
        date: '2030-01-01',
        startTime: '14:00',
        endTime: '16:00',
      }),
    ]);
    expect(result.nextAction).toBe('collect_fields');
    expect(result.interview.timeHint).toBeNull();
    expect(result.interview.registrationDeadlineHint).toBeNull();
    expect(result.fieldGuidance.sourceSummary).toContain('年龄 <- basic_personal_requirements');
    expect(result.fieldGuidance.enumHints.genderId).toEqual([
      { id: 1, label: '男' },
      { id: 2, label: '女' },
    ]);
    expect(result.bookingChecklist.requiredFields).toContain('姓名');
    expect(result.bookingChecklist.missingFields).toContain('姓名');
  });

  it('should expose interview time hint and registration deadline hint separately', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            firstInterview: {
              interviewTime:
                '每周都可以安排面试\n周一：13:30 下午-16:30 下午，提交面试名单截止时间为: 当天12:00 中午',
            },
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(true);
    expect(result.interview.timeHint).toBe('周一：13:30 下午-16:30 下午');
    expect(result.interview.registrationDeadlineHint).toContain('提交面试名单截止时间');
    expect(result.interview.registrationDeadlineHint).toContain('当天12:00 中午');
    expect(Array.isArray(result.interview.candidateTimeOptions)).toBe(true);
  });

  it('should parse 后天 / 本周X / 下周X / 4月12日 to normalized dates', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z')); // 上海时间 2026-04-07 10:30（周二）
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
    expect(dayAfterTomorrow.success).toBe(true);
    expect(dayAfterTomorrow.interview.normalizedRequestedDate).toBe('2026-04-09');

    const thisWeekFriday = await executeTool({ jobId: 100, requestedDate: '本周五' });
    expect(thisWeekFriday.success).toBe(true);
    expect(thisWeekFriday.interview.normalizedRequestedDate).toBe('2026-04-10');

    const nextWeekWednesday = await executeTool({ jobId: 100, requestedDate: '下周三' });
    expect(nextWeekWednesday.success).toBe(true);
    expect(nextWeekWednesday.interview.normalizedRequestedDate).toBe('2026-04-15');

    const monthDay = await executeTool({ jobId: 100, requestedDate: '4月12日' });
    expect(monthDay.success).toBe(true);
    expect(monthDay.interview.normalizedRequestedDate).toBe('2026-04-12');
  });

  it('should build booking checklist with known fields auto-filled from context', async () => {
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
            applied_store: null,
            applied_position: null,
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
    expect(result.bookingChecklist.knownFieldMap).toEqual(
      expect.objectContaining({
        姓名: '张三',
        联系电话: '13800138000',
        性别: '男',
        年龄: '30',
        学历: '本科',
        健康证情况: '有',
        应聘门店: '五角场店',
        应聘岗位: '服务员',
      }),
    );
    expect(result.bookingChecklist.missingFields).toContain('面试时间');
    expect(result.bookingChecklist.templateText).toContain('姓名：张三');
    expect(result.bookingChecklist.templateText).toContain('联系方式：13800138000');
    expect(result.bookingChecklist.templateText).toContain('应聘门店：五角场店');
    expect(result.nextAction).toBe('collect_fields');
  });

  it('should mark same-day windows as unavailable after the latest end time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T11:30:00.000Z'));
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
    expect(result.interview.requestedDateStatus).toBe('unavailable');
    expect(result.interview.canScheduleOnRequestedDate).toBe(false);
    expect(result.interview.requestedDateReason).toContain('18:00');
    expect(result.interview.requestedDateDecisionBasis).toBe('same_day_after_latest_window');
  });

  it('should ask for confirmation when same-day windows still remain', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T02:30:00.000Z'));
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
    expect(result.interview.requestedDateStatus).toBe('needs_confirmation');
    expect(result.interview.canScheduleOnRequestedDate).toBeNull();
    expect(result.interview.requestedDateDecisionBasis).toBe(
      'same_day_window_requires_confirmation',
    );
  });

  it('should block requested date when fixed booking deadline has passed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-07T05:00:00.000Z')); // 上海时间 13:00
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
    expect(result.interview.requestedDateStatus).toBe('unavailable');
    expect(result.interview.canScheduleOnRequestedDate).toBe(false);
    expect(result.interview.requestedDateDecisionBasis).toBe('after_booking_deadline');
    expect(result.interview.requestedDateReason).toContain('报名截止时间');
  });

  it('should block requested date when periodic booking deadline has passed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-08T05:00:00.000Z')); // 上海时间 13:00
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
    expect(result.interview.requestedDateStatus).toBe('unavailable');
    expect(result.interview.canScheduleOnRequestedDate).toBe(false);
    expect(result.interview.requestedDateDecisionBasis).toBe('after_booking_deadline');
    expect(result.interview.requestedDateReason).toContain('报名截止时间');
  });

  it('should surface Sponge errors as precheck_failed', async () => {
    mockSpongeService.fetchJobs.mockRejectedValue(new Error('API timeout'));

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('precheck_failed');
    expect(result.error).toContain('API timeout');
  });
});

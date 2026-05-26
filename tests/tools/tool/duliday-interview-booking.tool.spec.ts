import { buildInterviewBookingTool } from '@tools/duliday-interview-booking.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

describe('buildInterviewBookingTool', () => {
  const mockSpongeService = {
    fetchJobs: jest.fn(),
    bookInterview: jest.fn(),
  };

  const mockPrivateChatNotifier = {
    notifyInterviewBookingResult: jest.fn().mockResolvedValue(true),
  };

  const mockUserHostingService = {
    pauseUser: jest.fn().mockResolvedValue(undefined),
  };

  const mockRecruitmentCaseService = {
    openOnBookingSuccess: jest.fn().mockResolvedValue(undefined),
    getActiveOnboardFollowupCase: jest.fn().mockResolvedValue(null),
  };

  const mockBookingService = {
    incrementBookingCount: jest.fn().mockResolvedValue(undefined),
  };

  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    messages: [],
    contactName: '候选人微信名',
    botUserId: 'manager-1',
  };

  const validInput = {
    name: '张三',
    phone: '13800138000',
    age: 25,
    genderId: 1,
    jobId: 100,
    interviewTime: '2026-03-20 14:00:00',
    operateType: 6,
    prechecked: { nextAction: 'ready_to_book' as const, missingFieldsCount: 0 },
  };

  const makeJob = (overrides: Record<string, unknown> = {}) => {
    const {
      basicInfo: basicInfoOverrides = {},
      interviewProcess: interviewProcessOverrides = {},
      ...restOverrides
    } = overrides;

    return {
      basicInfo: {
        jobId: 100,
        brandName: '成都你六姐',
        jobName: '后厨-小时工',
        jobNickName: '后厨',
        storeInfo: {
          storeName: '上海浦江城市生活广场店',
        },
        ...(basicInfoOverrides as Record<string, unknown>),
      },
      interviewProcess: {
        interviewSupplement: [
          { interviewSupplementId: 2, interviewSupplement: '学历' },
          { interviewSupplementId: 3, interviewSupplement: '籍贯' },
          { interviewSupplementId: 4, interviewSupplement: '身高' },
        ],
        ...(interviewProcessOverrides as Record<string, unknown>),
      },
      ...restOverrides,
    };
  };

  beforeEach(() => jest.clearAllMocks());

  const flushAsyncEvents = async () => {
    await new Promise((resolve) => setImmediate(resolve));
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const executeToolWithContext = async (
    input: Record<string, any>,
    contextOverride: Partial<ToolBuildContext> = {},
  ) => {
    const mockLongTermService = {
      writeFromBooking: jest.fn().mockResolvedValue(undefined),
    };
    const builder = buildInterviewBookingTool(
      mockSpongeService as never,
      mockPrivateChatNotifier as never,
      mockUserHostingService as never,
      mockRecruitmentCaseService as never,
      mockBookingService as never,
      mockLongTermService as never,
    );
    const toolContext = {
      ...mockContext,
      ...contextOverride,
    };
    const builtTool = builder(toolContext);
    const result = (await builtTool.execute(input as any, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined as any,
    })) as any;
    return { result, context: toolContext };
  };

  const executeTool = async (
    input: Record<string, any>,
    contextOverride: Partial<ToolBuildContext> = {},
  ) => {
    const { result } = await executeToolWithContext(input, contextOverride);
    return result;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('should return error for missing required payload fields', async () => {
    const { result, context } = await executeToolWithContext({
      ...validInput,
      operateType: undefined,
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS);
    expect(result.missingFields).toContain('operateType');
    expect(context.bookingSucceeded).toBe(false);
    expect(result.requiredPayloadFields).toEqual([
      'jobId',
      'interviewTime',
      'name',
      'phone',
      'age',
      'genderId',
      'operateType',
    ]);
    expect(mockPrivateChatNotifier.notifyInterviewBookingResult).not.toHaveBeenCalled();
  });

  it('should skip external booking when an active appointment case already exists', async () => {
    mockRecruitmentCaseService.getActiveOnboardFollowupCase.mockResolvedValueOnce({
      id: 'case-1',
      corp_id: 'corp-1',
      chat_id: 'sess-1',
      user_id: 'user-1',
      case_type: 'onboard_followup',
      status: 'active',
      booking_id: 'BK-1001',
      booked_at: '2026-03-19T08:00:00.000Z',
      interview_time: '2026-03-20 14:00:00',
      job_id: 100,
      job_name: '后厨-小时工',
      brand_name: '成都你六姐',
      store_name: '上海浦江城市生活广场店',
      bot_im_id: 'bot-1',
      followup_window_ends_at: null,
      last_relevant_at: null,
      metadata: {},
      created_at: '2026-03-19T08:00:00.000Z',
      updated_at: '2026-03-19T08:00:00.000Z',
    });

    const context: Partial<ToolBuildContext> = {};
    const result = await executeTool(validInput, context);

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED);
    expect(result.currentBooking).toEqual(
      expect.objectContaining({
        bookingId: 'BK-1001',
        interviewTime: '2026-03-20 14:00:00',
        jobId: 100,
        jobName: '后厨-小时工',
        brandName: '成都你六姐',
        storeName: '上海浦江城市生活广场店',
      }),
    );
    expect(mockRecruitmentCaseService.getActiveOnboardFollowupCase).toHaveBeenCalledWith({
      corpId: 'corp-1',
      chatId: 'sess-1',
    });
    expect(mockSpongeService.fetchJobs).not.toHaveBeenCalled();
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    expect(mockRecruitmentCaseService.openOnBookingSuccess).not.toHaveBeenCalled();
    expect(mockPrivateChatNotifier.notifyInterviewBookingResult).not.toHaveBeenCalled();
  });

  describe('Phase 2-lite.1 prechecked contract', () => {
    it('rejects when prechecked.nextAction === "collect_fields"', async () => {
      const result = await executeTool({
        ...validInput,
        prechecked: { nextAction: 'collect_fields', missingFieldsCount: 3 },
      });
      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_REJECTED);
      expect(result._outcome).toContain('collect_fields');
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    });

    it('rejects when prechecked.nextAction === "confirm_date"', async () => {
      const result = await executeTool({
        ...validInput,
        prechecked: { nextAction: 'confirm_date', missingFieldsCount: 0 },
      });
      expect(result.success).toBe(false);
      expect(result._outcome).toContain('confirm_date');
    });

    it('rejects when prechecked.nextAction === "date_unavailable"', async () => {
      const result = await executeTool({
        ...validInput,
        prechecked: { nextAction: 'date_unavailable', missingFieldsCount: 0 },
      });
      expect(result.success).toBe(false);
      expect(result._outcome).toContain('date_unavailable');
    });

    it('rejects when missingFieldsCount > 0 even with ready_to_book', async () => {
      const result = await executeTool({
        ...validInput,
        prechecked: { nextAction: 'ready_to_book', missingFieldsCount: 2 },
      });
      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS);
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    });

    it('rejects with friendly error when prechecked is omitted entirely', async () => {
      // 模拟 LLM 漏调 precheck 直接 booking 的场景：prechecked 字段缺失。
      // schema 已松绑为 optional，不应被 Vercel AI SDK 卡在 schema validation，
      // 应该走 buildToolError → replyInstruction 让 LLM 先去调 precheck。
      const { prechecked, ...inputWithoutPrechecked } = validInput;
      void prechecked;
      const result = await executeTool(inputWithoutPrechecked);
      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_REJECTED);
      expect(result._outcome).toContain('未先调');
      expect(result._replyInstruction).toContain('duliday_interview_precheck');
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
      expect(mockRecruitmentCaseService.openOnBookingSuccess).not.toHaveBeenCalled();
    });
  });

  it('should return error for invalid time format', async () => {
    const result = await executeTool({ ...validInput, interviewTime: '2026/03/20 14:00' });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_INVALID_INTERVIEW_TIME);
    expect(result.detailedReason ?? result._replyInstruction).toContain('YYYY-MM-DD HH:mm:ss');
  });

  it('should return error for invalid age', async () => {
    const result = await executeTool({ ...validInput, age: 101 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_INVALID_AGE);
  });

  it('should return error for invalid genderId', async () => {
    const result = await executeTool({ ...validInput, genderId: 3 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_INVALID_GENDER_ID);
  });

  it('should return error for invalid operateType', async () => {
    const result = await executeTool({ ...validInput, operateType: 9 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_INVALID_OPERATE_TYPE);
  });

  it('should return error for invalid educationId', async () => {
    const result = await executeTool({ ...validInput, educationId: 99 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_INVALID_EDUCATION_ID);
    expect(result.availableEducationIds).toEqual(
      expect.objectContaining({
        2: '本科',
        3: '大专',
      }),
    );
  });

  it('should return error for invalid health certificate status', async () => {
    const result = await executeTool({ ...validInput, hasHealthCertificate: 4 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_INVALID_HEALTH_CERTIFICATE);
  });

  it('should return error for invalid health certificate types', async () => {
    const result = await executeTool({ ...validInput, healthCertificateTypes: [1, 7] });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_INVALID_HEALTH_CERTIFICATE_TYPES);
  });

  it('should return error when job lookup cannot find the job', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [] });

    const result = await executeTool(validInput);

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_JOB_NOT_FOUND);
    expect(result.detailedReason).toContain('jobId=100');
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
  });

  // Defense-in-depth: 三个 booking guard 在 LLM 跳过 precheck / 无视 precheck 警告时兜底。
  // 同源函数（isLikelyRealChineseName / findSameDayCutoffViolation / findScreeningFailure）
  // 已在 precheck 跑过一次，booking 这里是兜底再跑一次，避免 server-side 安全网被删后裸奔。
  it('booking guard: should reject when name fails isLikelyRealChineseName', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });

    const result = await executeTool({ ...validInput, name: 'Mike' });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS);
    expect(result._replyInstruction).toContain('真实姓名');
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
  });

  it('booking guard: should reject when interviewTime falls outside the job windows', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            interviewSupplement: [],
            firstInterview: {
              periodicInterviewTimes: [
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

    // 2026-03-19 是星期四，岗位只在每周五开窗——guard 应拦下
    const result = await executeTool({ ...validInput, interviewTime: '2026-03-19 14:00:00' });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_INVALID_INTERVIEW_TIME);
    expect(result.detailedReason).toContain('2026-03-19');
    expect(Array.isArray(result.availableSlots)).toBe(true);
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
  });

  it('booking guard: should reject when supplementAnswers hit a screening failure', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });

    // 食品相关专业的"在读/学过" 命中筛选 failSignal（label 带括号黑名单 "不要..." 触发
    // BLACKLIST_PAREN_REGEX 分类为 screening；answer 含 "食品" 命中 failSignal）
    const result = await executeTool({
      ...validInput,
      supplementAnswers: { '专业（不要食品/食安/卫检等专业）': '我是食品专业的' },
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_REJECTED);
    expect(result._replyInstruction).toContain('筛选');
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
  });

  // 时段窗口/报名截止/dateOnly 等时段硬规则的二次校验已经从 booking 移除——
  // 由 duliday_interview_precheck 前置拦截，booking 信任 precheck 的结论。
  // 仍保留一条"合法时段提交成功"的正路径，作为 booking 端的烟雾测试。
  it('should submit the booking when interviewTime is supplied (precheck is trusted to have validated it)', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            interviewSupplement: [],
            firstInterview: {
              periodicInterviewTimes: [
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
    mockSpongeService.bookInterview.mockResolvedValue({
      success: true,
      code: 0,
      message: '预约成功',
      notice: null,
      errorList: null,
    });

    const result = await executeTool({
      ...validInput,
      interviewTime: '2026-03-20 14:00:00',
    });

    expect(result.success).toBe(true);
    expect(mockSpongeService.bookInterview).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewTime: '2026-03-20 14:00:00',
      }),
    );
  });

  it('should build customerLabelList from real job supplements and candidate info', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            interviewSupplement: [
              { interviewSupplementId: 2, interviewSupplement: '学历' },
              { interviewSupplementId: 3, interviewSupplement: '籍贯' },
              { interviewSupplementId: 4, interviewSupplement: '身高' },
              { interviewSupplementId: 190, interviewSupplement: '爱好' },
            ],
          },
        }),
      ],
    });
    mockSpongeService.bookInterview.mockResolvedValue({
      success: true,
      code: 0,
      message: '预约成功',
      notice: '请准时到达',
      errorList: null,
    });

    const result = await executeTool({
      ...validInput,
      educationId: 2,
      householdRegisterProvinceId: 310000,
      height: 172,
      supplementAnswers: {
        爱好: '打篮球',
      },
    });
    await flushAsyncEvents();

    expect(result.success).toBe(true);
    expect(result.notice).toBe('请准时到达');
    expect(mockSpongeService.fetchJobs).toHaveBeenCalledWith({
      jobIdList: [100],
      pageNum: 1,
      pageSize: 1,
      options: {
        includeBasicInfo: true,
        includeInterviewProcess: true,
      },
    });
    expect(mockSpongeService.bookInterview).toHaveBeenCalledWith({
      jobId: 100,
      interviewTime: '2026-03-20 14:00:00',
      name: '张三',
      phone: '13800138000',
      age: 25,
      genderId: 1,
      operateType: 6,
      avatar: undefined,
      householdRegisterProvinceId: 310000,
      height: 172,
      weight: undefined,
      hasHealthCertificate: undefined,
      healthCertificateTypes: undefined,
      educationId: 2,
      uploadResume: undefined,
      customerLabelList: [
        {
          labelId: 2,
          labelName: '学历',
          name: '学历',
          value: '本科',
        },
        {
          labelId: 3,
          labelName: '籍贯',
          name: '籍贯',
          value: '上海市',
        },
        {
          labelId: 4,
          labelName: '身高',
          name: '身高',
          value: '172',
        },
        {
          labelId: 190,
          labelName: '爱好',
          name: '爱好',
          value: '打篮球',
        },
      ],
      logId: undefined,
    });
    expect(mockPrivateChatNotifier.notifyInterviewBookingResult).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateName: '张三',
        phone: '13800138000',
        genderLabel: '男',
        ageText: '25岁',
        brandName: '成都你六姐',
        storeName: '上海浦江城市生活广场店',
        jobName: '后厨-小时工',
        jobId: 100,
        interviewTime: '2026-03-20 14:00:00',
        toolOutput: expect.objectContaining({
          success: true,
          notice: '请准时到达',
          requestInfo: expect.objectContaining({
            operateType: 6,
            educationId: 2,
            supplementAnswers: {
              爱好: '打篮球',
            },
            customerLabelList: expect.arrayContaining([
              expect.objectContaining({
                labelId: 190,
                labelName: '爱好',
                value: '打篮球',
              }),
            ]),
          }),
        }),
      }),
    );
    expect(mockUserHostingService.pauseUser).not.toHaveBeenCalled();
    expect(mockRecruitmentCaseService.openOnBookingSuccess).toHaveBeenCalledWith({
      corpId: 'corp-1',
      chatId: 'sess-1',
      userId: 'user-1',
      snapshot: expect.objectContaining({
        bookingId: null,
        interviewTime: '2026-03-20 14:00:00',
        jobId: 100,
        jobName: '后厨-小时工',
        brandName: '成都你六姐',
        storeName: '上海浦江城市生活广场店',
        botImId: undefined,
        metadata: { tool: 'duliday_interview_booking' },
      }),
    });
    expect(mockBookingService.incrementBookingCount).toHaveBeenCalledWith({
      brandName: '成都你六姐',
      storeName: '上海浦江城市生活广场店',
      chatId: 'sess-1',
      userId: 'user-1',
      userName: '候选人微信名',
      managerId: 'manager-1',
      managerName: 'manager-1',
    });
  });

  it('should return missing_customer_label_values when supplements require unknown answers', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            interviewSupplement: [{ interviewSupplementId: 190, interviewSupplement: '爱好' }],
          },
        }),
      ],
    });

    const result = await executeTool(validInput);

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_CUSTOMER_LABEL_VALUES);
    expect(result.missingSupplementLabels).toEqual(['爱好']);
    expect(result.customerLabelDefinitions).toEqual([
      {
        labelId: 190,
        labelName: '爱好',
        name: '爱好',
      },
    ]);
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
  });

  it('should handle SpongeService booking errors after resolving supplements', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJob()],
    });
    mockSpongeService.bookInterview.mockRejectedValue(new Error('Network error'));

    const result = await executeTool({
      ...validInput,
      educationId: 2,
      householdRegisterProvinceId: 310000,
      height: 172,
    });
    await flushAsyncEvents();

    expect(result.success).toBe(false);
    expect(result.reason).toBe('Network error');
    expect(mockPrivateChatNotifier.notifyInterviewBookingResult).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateName: '张三',
        phone: '13800138000',
        genderLabel: '男',
        ageText: '25岁',
        interviewTime: '2026-03-20 14:00:00',
        toolOutput: expect.objectContaining({
          success: false,
          errorType: TOOL_ERROR_TYPES.BOOKING_REQUEST_FAILED,
          requestInfo: expect.objectContaining({
            operateType: 6,
            customerLabelList: [
              {
                labelId: 2,
                labelName: '学历',
                name: '学历',
                value: '本科',
              },
              {
                labelId: 3,
                labelName: '籍贯',
                name: '籍贯',
                value: '上海市',
              },
              {
                labelId: 4,
                labelName: '身高',
                name: '身高',
                value: '172',
              },
            ],
          }),
        }),
      }),
    );
    expect(mockUserHostingService.pauseUser).toHaveBeenCalledWith('sess-1');
    expect(mockRecruitmentCaseService.openOnBookingSuccess).not.toHaveBeenCalled();
    expect(mockBookingService.incrementBookingCount).not.toHaveBeenCalled();
  });

  it('should not fail the booking result when async pauseUser rejects', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJob()],
    });
    mockSpongeService.bookInterview.mockResolvedValue({
      success: false,
      code: 500,
      message: '预约失败',
      errorList: ['门店不可约'],
    });
    mockUserHostingService.pauseUser.mockRejectedValueOnce(new Error('Pause failed'));

    const result = await executeTool({
      ...validInput,
      educationId: 2,
      householdRegisterProvinceId: 310000,
      height: 172,
    });
    await flushAsyncEvents();

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_REJECTED);
    expect(mockUserHostingService.pauseUser).toHaveBeenCalledWith('sess-1');
  });
});

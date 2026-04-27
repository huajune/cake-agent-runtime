import { buildInterviewBookingTool } from '@tools/duliday-interview-booking.tool';
import { ToolBuildContext } from '@shared-types/tool.types';

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
  const executeTool = async (
    input: Record<string, any>,
    contextOverride: Partial<ToolBuildContext> = {},
  ) => {
    const builder = buildInterviewBookingTool(
      mockSpongeService as never,
      mockPrivateChatNotifier as never,
      mockUserHostingService as never,
      mockRecruitmentCaseService as never,
      mockBookingService as never,
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

  it('should return error for missing required payload fields', async () => {
    const result = await executeTool({ ...validInput, operateType: undefined });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('missing_fields');
    expect(result.missingFields).toContain('operateType');
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
    expect(result.errorType).toBe('already_booked');
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

  it('should return error for invalid time format', async () => {
    const result = await executeTool({ ...validInput, interviewTime: '2026/03/20 14:00' });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('invalid_interview_time');
    expect(result.error).toContain('YYYY-MM-DD HH:mm:ss');
  });

  it('should return error for invalid age', async () => {
    const result = await executeTool({ ...validInput, age: 101 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('invalid_age');
  });

  it('should return error for invalid genderId', async () => {
    const result = await executeTool({ ...validInput, genderId: 3 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('invalid_gender_id');
  });

  it('should return error for invalid operateType', async () => {
    const result = await executeTool({ ...validInput, operateType: 9 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('invalid_operate_type');
  });

  it('should return error for invalid educationId', async () => {
    const result = await executeTool({ ...validInput, educationId: 99 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('invalid_education_id');
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
    expect(result.errorType).toBe('invalid_health_certificate');
  });

  it('should return error for invalid health certificate types', async () => {
    const result = await executeTool({ ...validInput, healthCertificateTypes: [1, 7] });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('invalid_health_certificate_types');
  });

  it('should return error when job lookup cannot find the job', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [] });

    const result = await executeTool(validInput);

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('job_not_found');
    expect(result.error).toContain('jobId=100');
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
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
    expect(result.errorType).toBe('missing_customer_label_values');
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
    expect(result.error).toContain('Network error');
    expect(mockPrivateChatNotifier.notifyInterviewBookingResult).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateName: '张三',
        phone: '13800138000',
        genderLabel: '男',
        ageText: '25岁',
        interviewTime: '2026-03-20 14:00:00',
        toolOutput: expect.objectContaining({
          success: false,
          errorType: 'booking_request_failed',
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
    expect(result.errorType).toBe('booking_rejected');
    expect(mockUserHostingService.pauseUser).toHaveBeenCalledWith('sess-1');
  });
});

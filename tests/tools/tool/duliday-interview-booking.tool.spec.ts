import { buildInterviewBookingTool } from '@tools/duliday-interview-booking.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

describe('buildInterviewBookingTool', () => {
  const mockSpongeService = {
    fetchJobs: jest.fn(),
    bookInterview: jest.fn(),
    uploadAttachmentFromUrl: jest.fn(),
    getCachedWorkOrderById: jest.fn(),
  };

  const mockPrivateChatNotifier = {
    notifyInterviewBookingResult: jest.fn().mockResolvedValue(true),
  };

  const mockUserHostingService = {
    pauseUser: jest.fn().mockResolvedValue(undefined),
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

  beforeEach(() => {
    jest.clearAllMocks();
    mockSpongeService.uploadAttachmentFromUrl.mockResolvedValue({
      fileName: '张三简历.pdf',
      cloudStorageKey: 'resume/cloud/key.pdf',
    });
    // 软查重反查工单默认查不到手机号 → 保守按重复拦截（与海绵不可用时的兜底行为一致）
    mockSpongeService.getCachedWorkOrderById.mockResolvedValue(null);
  });

  const flushAsyncEvents = async () => {
    await new Promise((resolve) => setImmediate(resolve));
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const executeToolWithContext = async (
    input: Record<string, any>,
    contextOverride: Partial<ToolBuildContext> = {},
    options: { activeBooking?: Record<string, unknown> | null } = {},
  ) => {
    const mockLongTermService = {
      writeFromBooking: jest.fn().mockResolvedValue(undefined),
      setActiveBooking: jest.fn().mockResolvedValue(undefined),
      getActiveBooking: jest.fn().mockResolvedValue(options.activeBooking ?? null),
      getActiveBookings: jest
        .fn()
        .mockResolvedValue(options.activeBooking ? [options.activeBooking] : []),
    };
    const mockOpsEventsRecorder = {
      recordEvent: jest.fn().mockResolvedValue(undefined),
    };
    const builder = buildInterviewBookingTool(
      mockSpongeService as never,
      mockPrivateChatNotifier as never,
      mockUserHostingService as never,
      mockLongTermService as never,
      mockOpsEventsRecorder as never,
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
    return {
      result,
      context: toolContext,
      mocks: {
        mockLongTermService,
        mockOpsEventsRecorder,
      },
    };
  };

  const executeTool = async (
    input: Record<string, any>,
    contextOverride: Partial<ToolBuildContext> = {},
    options: { activeBooking?: Record<string, unknown> | null } = {},
  ) => {
    const { result } = await executeToolWithContext(input, contextOverride, options);
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

    it('rejects when prechecked.nextAction === "student_rejected"', async () => {
      const result = await executeTool({
        ...validInput,
        prechecked: { nextAction: 'student_rejected', missingFieldsCount: 0 },
      });
      expect(result.success).toBe(false);
      expect(result._outcome).toContain('student_rejected');
      expect(result._replyInstruction).toContain('学生身份');
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
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
    });
  });

  describe('jobId provenance 闸门', () => {
    it('jobId 无召回出处时拦截，不打 Sponge、不下预约', async () => {
      // 模型伪造 prechecked 直接进 booking、且 jobId 本会话从未召回（凭空/串改命中真岗位）
      const { result, context } = await executeToolWithContext(validInput, {
        isRecalledJobId: () => false,
      });

      expect(result.success).toBe(false);
      expect(result).toMatchObject({
        shortCircuited: true,
        gateRejected: true,
        reasonCode: 'job_id_not_recalled',
      });
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_JOB_NOT_PROVIDED);
      expect(result._replyInstruction).toContain('runtime 已短路本轮');
      expect(context.bookingSucceeded).toBe(false);
      expect(mockSpongeService.fetchJobs).not.toHaveBeenCalled();
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    });

    it('jobId 有召回出处时放行闸门（继续走后续校验/下单）', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
      mockSpongeService.bookInterview.mockResolvedValue({ success: true, data: { id: 1 } });

      await executeTool(validInput, { isRecalledJobId: () => true });

      // 放行闸门后落到既有 fetchJobs 路径（不再被 job_not_provided 短路）
      expect(mockSpongeService.fetchJobs).toHaveBeenCalled();
    });

    it('未注入 isRecalledJobId（test/debug 链路）时跳过闸门，向后兼容', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
      mockSpongeService.bookInterview.mockResolvedValue({ success: true, data: { id: 1 } });

      const result = await executeTool(validInput);

      expect(result.errorType).not.toBe(TOOL_ERROR_TYPES.BOOKING_JOB_NOT_PROVIDED);
      expect(mockSpongeService.fetchJobs).toHaveBeenCalled();
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

  it('HC-2 name gate: rejects a format-valid name that only appears as an auto-greeting nickname', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });

    // "小王" 形态合法（checkRealName 放行），但原文里只是"我是小王"打招呼昵称
    const result = await executeTool(
      { ...validInput, name: '小王' },
      { messages: [{ role: 'user', content: '我是小王' }] },
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS);
    expect(result._replyInstruction).toContain('真实姓名');
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
  });

  it('HC-2 name gate: does NOT fire for a name with a structured user_text source', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });

    // 有结构化出处 → name gate 放行；即便后续别的环节失败，也不应是 name gate 的拒绝理由
    const result = await executeTool(
      { ...validInput, name: '小王' },
      { messages: [{ role: 'user', content: '姓名：小王' }] },
    );

    expect(result._replyInstruction ?? '').not.toContain('打招呼语昵称');
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

  it('booking guard: forged ready_to_book still rejects explicit student form for social-only job', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJob({ hiringRequirement: { figure: '社会人士' } })],
    });

    const result = await executeTool(validInput, {
      currentUserMessage: '姓名：罗瑞雪\n年龄：19\n身份（学生/社会人士）：学生',
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_REJECTED);
    expect(result._outcome).toContain('学生身份');
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
      expect.objectContaining({ botUserId: 'manager-1' }),
    );
  });

  it('returns online completion guidance instead of an on-site script for AI interviews', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            interviewSupplement: [],
            firstInterview: {
              firstInterviewWay: '线上面试',
              firstInterviewDesc: '线上 AI 面试',
            },
          },
        }),
      ],
    });
    mockSpongeService.bookInterview.mockResolvedValue({
      success: true,
      code: 0,
      message: '预约成功',
      workOrderId: 555,
    });

    const result = await executeTool(validInput);

    expect(result.success).toBe(true);
    expect(result.requestInfo.interviewType).toBe('AI面试');
    expect(result._aiInterviewGuide).toContain('无需到店');
    expect(result._aiInterviewGuide).toContain('在线完成');
    expect(result._onSiteScript).toBeUndefined();
  });

  describe('wait_notice（岗位未配置面试时段，等通知）', () => {
    it('should book without interviewTime for jobs without interview windows', async () => {
      // 默认 makeJob 无任何面试窗口（等通知岗位）；带"面试时间"标签验证回填"等待通知"
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJob({
            interviewProcess: {
              interviewSupplement: [{ interviewSupplementId: 5, interviewSupplement: '面试时间' }],
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

      const { interviewTime, ...inputWithoutTime } = validInput;
      void interviewTime;
      const result = await executeTool(inputWithoutTime);
      await flushAsyncEvents();

      expect(result.success).toBe(true);
      const bookingPayload = mockSpongeService.bookInterview.mock.calls[0][0];
      expect(bookingPayload.interviewTime).toBeUndefined();
      // "面试时间"补充标签按平台口径回填"等待通知"
      expect(bookingPayload.customerLabelList).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ labelName: '面试时间', value: '等待通知' }),
        ]),
      );
      // 回复指引切换为"面试官电话联系"，没有时间点和到店脚本可复述
      expect(result._confirmedInterviewTimeHuman).toContain('电话');
      expect(result._waitNoticeReplyGuide).toContain('保持电话畅通');
      expect(result._onSiteScript).toBeUndefined();
      expect(mockPrivateChatNotifier.notifyInterviewBookingResult).toHaveBeenCalledWith(
        expect.objectContaining({
          interviewTime: '等待通知（面试官电话联系）',
        }),
      );
    });

    it('should still require interviewTime for jobs that have interview windows', async () => {
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

      const { interviewTime, ...inputWithoutTime } = validInput;
      void interviewTime;
      const result = await executeTool(inputWithoutTime);

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_FIELDS);
      expect(result.missingFields).toEqual(['interviewTime']);
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    });

    it('should book without interviewTime for 审简历优先 jobs even when windows exist', async () => {
      // badcase chat 6a2fac72…：岗位配了面试时段窗口，但 interviewAddress 是"先审核简历，
      // 待简历审核通过后，告知面试地点&时间"。precheck 已按 wait_notice 放行 ready_to_book，
      // booking 必须用同一口径（isWaitNoticeInterview）放行不带 interviewTime 的提交，
      // 否则会因"该岗位配置了面试时段"把预约打回 → 候选人简历石沉大海。
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJob({
            interviewProcess: {
              interviewSupplement: [],
              firstInterview: {
                interviewAddress: '先审核简历，待简历审核通过后，告知面试地点&时间',
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

      // 审简历岗策略文本含"简历审核"→ 必须带简历附件（这本身是正确约束），故提供 uploadResume
      const { interviewTime, ...rest } = validInput;
      void interviewTime;
      const inputWithoutTime = { ...rest, uploadResume: 'https://oss.example.com/resume.jpg' };
      const result = await executeTool(inputWithoutTime);
      await flushAsyncEvents();

      expect(result.success).toBe(true);
      expect(mockSpongeService.bookInterview).toHaveBeenCalled();
      expect(mockSpongeService.bookInterview.mock.calls[0][0].interviewTime).toBeUndefined();
      expect(result._waitNoticeReplyGuide).toContain('保持电话畅通');
    });
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

    const { result, mocks } = await executeToolWithContext({
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
    expect(mockSpongeService.fetchJobs).toHaveBeenCalledWith(
      {
        jobIdList: [100],
        pageNum: 1,
        pageSize: 1,
        options: {
          includeBasicInfo: true,
          includeInterviewProcess: true,
        },
      },
      expect.objectContaining({ botUserId: 'manager-1' }),
    );
    expect(mockSpongeService.bookInterview).toHaveBeenCalledWith(
      {
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
      },
      expect.objectContaining({ botUserId: 'manager-1' }),
    );
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
    expect(mocks.mockOpsEventsRecorder.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'booking.succeeded',
        payload: expect.objectContaining({
          brand_name: '成都你六姐',
          store_name: '上海浦江城市生活广场店',
        }),
      }),
    );
  });

  it('should upload resume URL first and pass cloudStorageKey to entryUser', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            interviewSupplement: [{ interviewSupplementId: 9, interviewSupplement: '简历' }],
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

    const result = await executeTool(
      {
        ...validInput,
        uploadResume: 'https://wecom.example.com/file/resume.pdf',
      },
      {
        messages: [
          {
            role: 'user',
            content:
              '[文件消息] 文件名：张三简历.pdf；文件地址：https://wecom.example.com/file/resume.pdf；文件大小：2KB\n简历附件：https://wecom.example.com/file/resume.pdf',
          },
        ],
      },
    );

    expect(result.success).toBe(true);
    expect(mockSpongeService.uploadAttachmentFromUrl).toHaveBeenCalledWith(
      {
        fileUrl: 'https://wecom.example.com/file/resume.pdf',
        fileName: '张三简历.pdf',
      },
      expect.objectContaining({ botUserId: 'manager-1' }),
    );
    expect(mockSpongeService.bookInterview).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadResume: 'resume/cloud/key.pdf',
        customerLabelList: [
          {
            labelId: 9,
            labelName: '简历',
            name: '简历',
            value: 'resume/cloud/key.pdf',
          },
        ],
      }),
      expect.objectContaining({ botUserId: 'manager-1' }),
    );
    expect(result.requestInfo).toEqual(
      expect.objectContaining({
        uploadResume: 'resume/cloud/key.pdf',
        customerLabelList: [
          {
            labelId: 9,
            labelName: '简历',
            name: '简历',
            value: 'resume/cloud/key.pdf',
          },
        ],
      }),
    );
  });

  it('rejects resume-required jobs when only text experience is provided as 上传简历', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            interviewSupplement: [{ interviewSupplementId: 49, interviewSupplement: '上传简历' }],
          },
        }),
      ],
    });

    const result = await executeTool({
      ...validInput,
      supplementAnswers: {
        上传简历: '南京城市职业学院毕业。高铁检票员1年，蜜雪冰城饮品师8个月',
      },
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_CUSTOMER_LABEL_VALUES);
    expect(result.missingFields).toEqual(['简历附件']);
    expect(result.missingSupplementLabels).toEqual(['上传简历']);
    expect(result._replyInstruction).toContain('PDF 简历文件');
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    expect(mockSpongeService.uploadAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it('rejects free-text uploadResume on resume-required jobs (工单 438358 badcase)', async () => {
    // 自由文字既不是 URL 也不是云存储 key，不得被当作简历附件提交，
    // 否则海绵侧工单的"上传简历"会存一段文字、附件打不开。
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            interviewSupplement: [{ interviewSupplementId: 49, interviewSupplement: '上传简历' }],
          },
        }),
      ],
    });

    const result = await executeTool({
      ...validInput,
      uploadResume: '过往公司+岗位+年限：通州一建建设集团有限公司+管理+5年',
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_CUSTOMER_LABEL_VALUES);
    expect(result.missingFields).toEqual(['简历附件']);
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    expect(mockSpongeService.uploadAttachmentFromUrl).not.toHaveBeenCalled();
  });

  it('rejects free-text resume polluted into session facts (工单 438358 badcase)', async () => {
    // 438358 实际链路：booking 入参没传 uploadResume，文字经会话事实兜底流入。
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            interviewSupplement: [{ interviewSupplementId: 49, interviewSupplement: '上传简历' }],
          },
        }),
      ],
    });

    const result = await executeTool(validInput, {
      sessionFacts: {
        interview_info: {
          upload_resume: '过往公司+岗位+年限：通州一建建设集团有限公司+管理+5年',
        },
      } as never,
    });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_MISSING_CUSTOMER_LABEL_VALUES);
    expect(result.missingFields).toEqual(['简历附件']);
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
  });

  it('passes through cloudStorageKey-shaped uploadResume without re-uploading', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          interviewProcess: {
            interviewSupplement: [{ interviewSupplementId: 49, interviewSupplement: '上传简历' }],
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
      uploadResume: '刘渔林_20260609135452_20260610095630.docx',
    });

    expect(result.success).toBe(true);
    expect(mockSpongeService.uploadAttachmentFromUrl).not.toHaveBeenCalled();
    expect(mockSpongeService.bookInterview).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadResume: '刘渔林_20260609135452_20260610095630.docx',
      }),
      expect.objectContaining({ botUserId: 'manager-1' }),
    );
  });

  it('instructs handoff when a fresh resume arrives after the candidate is already booked', async () => {
    // 438358 第二段：预约成功 23 秒后候选人补发真简历，命中 already_booked 短路，
    // 真简历被静默丢弃且 Agent 回复"已提交"。现在应指示转人工补传。
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });

    const result = await executeTool(
      {
        ...validInput,
        educationId: 2,
        householdRegisterProvinceId: 310000,
        height: 172,
        uploadResume: 'https://wecom.example.com/file/resume.pdf',
      },
      {
        highConfidenceFacts: {
          interview_info: {
            upload_resume: {
              value: 'https://wecom.example.com/file/resume.pdf',
              confidence: 'high',
              source: 'rule',
            },
          },
        } as never,
      },
      {
        activeBooking: {
          work_order_id: 438358,
          linked_at: new Date().toISOString(),
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED);
    expect(result.existingWorkOrderId).toBe(438358);
    expect(result._replyInstruction).toContain('system_blocked');
    expect(result._replyInstruction).toContain('补传');
    expect(result._replyInstruction).toContain('438358');
    expect(result.pendingUploadResume).toBe('resume/cloud/key.pdf');
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
  });

  it('keeps the plain already-booked instruction when no fresh resume arrived this turn', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });

    const result = await executeTool(
      {
        ...validInput,
        educationId: 2,
        householdRegisterProvinceId: 310000,
        height: 172,
      },
      {},
      {
        activeBooking: {
          work_order_id: 438358,
          linked_at: new Date().toISOString(),
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED);
    expect(result._replyInstruction).toContain('modify_appointment');
    expect(result.pendingUploadResume).toBeUndefined();
    expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
  });

  it('allows booking a different job when another recent active booking exists', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          basicInfo: {
            jobId: 200,
            brandName: '必胜客',
            jobName: '内场',
            jobNickName: '内场',
          },
        }),
      ],
    });
    mockSpongeService.bookInterview.mockResolvedValue({
      success: true,
      code: 0,
      message: '预约成功',
      workOrderId: 445999,
    });

    const { result, mocks } = await executeToolWithContext(
      {
        ...validInput,
        jobId: 200,
        educationId: 3,
        householdRegisterProvinceId: 310000,
        height: 170,
      },
      {},
      {
        activeBooking: {
          work_order_id: 445383,
          job_id: 100,
          linked_at: new Date().toISOString(),
        },
      },
    );

    expect(result.success).toBe(true);
    expect(mockSpongeService.bookInterview).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 200 }),
      expect.anything(),
    );
    expect(mocks.mockLongTermService.setActiveBooking).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      445999,
      { job_id: 200 },
    );
  });

  describe('软查重手机号交叉核验（工单 448367→448402 badcase）', () => {
    // 同一个企微联系人先后给两个不同的人报同一岗位：罗欣宇约成功后 30 分钟内，
    // 同会话给许颖（另一手机号）报同岗位被误判 already_booked。命中指针后应
    // 反查工单手机号：不同手机号 = 不同候选人，放行。
    const recentActiveBooking = {
      work_order_id: 448367,
      job_id: 100,
      linked_at: new Date().toISOString(),
    };

    it('工单手机号与本次不同（不同候选人）时应放行，正常提交预约', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
      mockSpongeService.getCachedWorkOrderById.mockResolvedValue({
        workOrderId: 448367,
        phone: '13554730335',
      });
      mockSpongeService.bookInterview.mockResolvedValue({
        success: true,
        code: 0,
        message: '预约成功',
        workOrderId: 448402,
      });

      const result = await executeTool(
        {
          ...validInput,
          phone: '13750091607',
          educationId: 2,
          householdRegisterProvinceId: 310000,
          height: 170,
        },
        {},
        { activeBooking: recentActiveBooking },
      );

      expect(mockSpongeService.getCachedWorkOrderById).toHaveBeenCalledWith(
        448367,
        expect.anything(),
      );
      expect(result.success).toBe(true);
      expect(mockSpongeService.bookInterview).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '13750091607' }),
        expect.anything(),
      );
    });

    it('工单手机号与本次相同（真·重复提交）时仍应拦截', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
      mockSpongeService.getCachedWorkOrderById.mockResolvedValue({
        workOrderId: 448367,
        phone: '13800138000',
      });

      const result = await executeTool(
        { ...validInput, educationId: 2, householdRegisterProvinceId: 310000, height: 170 },
        {},
        { activeBooking: recentActiveBooking },
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED);
      expect(result.existingWorkOrderId).toBe(448367);
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    });

    it('手机号比对应忽略空格/连字符等格式差异', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
      mockSpongeService.getCachedWorkOrderById.mockResolvedValue({
        workOrderId: 448367,
        phone: '138-0013-8000',
      });

      const result = await executeTool(
        {
          ...validInput,
          phone: '138 0013 8000',
          educationId: 2,
          householdRegisterProvinceId: 310000,
          height: 170,
        },
        {},
        { activeBooking: recentActiveBooking },
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED);
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    });

    it('反查工单失败（海绵异常）时应保守拦截，保留防重试兜底', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
      mockSpongeService.getCachedWorkOrderById.mockRejectedValue(new Error('sponge down'));

      const result = await executeTool(
        { ...validInput, educationId: 2, householdRegisterProvinceId: 310000, height: 170 },
        {},
        { activeBooking: recentActiveBooking },
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED);
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
    });

    it('工单缺手机号时应保守拦截', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
      mockSpongeService.getCachedWorkOrderById.mockResolvedValue({
        workOrderId: 448367,
        phone: null,
      });

      const result = await executeTool(
        { ...validInput, educationId: 2, householdRegisterProvinceId: 310000, height: 170 },
        {},
        { activeBooking: recentActiveBooking },
      );

      expect(result.success).toBe(false);
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.BOOKING_ALREADY_BOOKED);
      expect(mockSpongeService.bookInterview).not.toHaveBeenCalled();
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
    expect(mockUserHostingService.pauseUser).toHaveBeenCalledWith('sess-1', expect.any(Object));
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
    expect(mockUserHostingService.pauseUser).toHaveBeenCalledWith('sess-1', expect.any(Object));
  });
});

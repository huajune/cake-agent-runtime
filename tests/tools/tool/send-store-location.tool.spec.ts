import { buildSendStoreLocationTool } from '@tools/send-store-location.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { SendMessageType } from '@channels/wecom/message-sender/dto/send-message.dto';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

describe('buildSendStoreLocationTool', () => {
  const mockSpongeService = {
    fetchJobs: jest.fn(),
  };

  const mockMessageSenderService = {
    sendMessage: jest.fn(),
  };

  const mockGeocodingService = {
    geocode: jest.fn(),
  };

  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    messages: [],
    botImId: 'bot-im-1',
    token: 'token-1',
    imContactId: 'contact-1',
    chatId: 'chat-1',
    apiType: 'enterprise',
    currentFocusJob: {
      jobId: 100,
      brandName: '必胜客',
      jobName: '青塔店-兼职',
      storeName: '青塔店',
      storeAddress: '北京市丰台区青塔西路 1 号',
      cityName: '北京市',
      regionName: '丰台区',
      laborForm: '兼职',
      salaryDesc: '20元/时',
      jobCategoryName: '服务员',
    },
  };

  const makeJob = (overrides: Record<string, unknown> = {}) => ({
    basicInfo: {
      jobId: 100,
      jobName: '北京必胜客-青塔-服务员-兼职',
      storeInfo: {
        storeName: '青塔店',
        storeAddress: '北京市丰台区青塔西路 1 号',
        latitude: 39.8801,
        longitude: 116.2812,
      },
      ...overrides,
    },
  });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const executeTool = async (
    input: Record<string, any>,
    contextOverride: Partial<ToolBuildContext> = {},
  ) => {
    const builder = buildSendStoreLocationTool(
      mockSpongeService as any,
      mockMessageSenderService as any,
      mockGeocodingService as any,
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
  });

  it('should send location message for explicit jobId', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJob()],
    });
    mockMessageSenderService.sendMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(true);
    expect(result._fixedReply).toBe('门店位置我发你了，你点开就能看导航。');
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
      expect.objectContaining({ botImId: 'bot-im-1' }),
    );
    expect(mockMessageSenderService.sendMessage).toHaveBeenCalledWith({
      token: 'token-1',
      imBotId: 'bot-im-1',
      imContactId: 'contact-1',
      imRoomId: undefined,
      chatId: 'chat-1',
      messageType: SendMessageType.LOCATION,
      payload: {
        accuracy: 15,
        address: '北京市丰台区青塔西路 1 号',
        latitude: 39.8801,
        longitude: 116.2812,
        name: '青塔店',
      },
      _apiType: 'enterprise',
    });
  });

  it('should fallback to current focus job when jobId is omitted', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJob()],
    });
    mockMessageSenderService.sendMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    const result = await executeTool({});

    expect(result.success).toBe(true);
    expect(mockSpongeService.fetchJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        jobIdList: [100],
      }),
      expect.objectContaining({ botImId: 'bot-im-1' }),
    );
  });

  it('should return error when delivery context is missing', async () => {
    const result = await executeTool(
      { jobId: 100 },
      {
        token: undefined,
      },
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.STORE_LOCATION_MISSING_DELIVERY_CONTEXT);
    expect(mockSpongeService.fetchJobs).not.toHaveBeenCalled();
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
  });

  it('should append floor hint extracted from store address', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          storeInfo: {
            storeName: '上海置汇旭辉店',
            storeAddress: '上海市-浦东新区-张杨路2389弄1-2号LCM置汇旭辉广场B1层48-50号成都你六姐',
            latitude: 31.2421,
            longitude: 121.5557,
          },
        }),
      ],
    });
    mockMessageSenderService.sendMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(true);
    expect(result.floorHint).not.toBeNull();
    expect(result.floorHint).toMatch(/B1\s*层|48-50\s*号/);
    expect(result._fixedReply).toContain('门店位置我发你了');
    expect(result._fixedReply).toContain('别走错');
  });

  it('should fallback to plain reply when address has no floor hint', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJob()],
    });
    mockMessageSenderService.sendMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(true);
    expect(result.floorHint).toBeNull();
    expect(result._fixedReply).toBe('门店位置我发你了，你点开就能看导航。');
  });

  it('should return fallback info when store coordinates are unavailable', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          storeInfo: {
            storeName: '青塔店',
            storeAddress: '北京市丰台区青塔西路 1 号',
          },
        }),
      ],
    });

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.STORE_LOCATION_UNAVAILABLE);
    expect(result.storeAddress).toBe('北京市丰台区青塔西路 1 号');
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
  });

  it('进行中预约的地址质疑应发送面试地点，不得发新门店定位', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        {
          ...makeJob({
            storeInfo: {
              storeName: '上海东方渔人码头店',
              storeAddress: '上海东方渔人码头成都你六姐F1楼',
              storeCityName: '上海市',
              latitude: 31.251,
              longitude: 121.55,
            },
          }),
          interviewProcess: {
            firstInterview: {
              firstInterviewWay: '线下面试',
              interviewAddress: '新店开业前在成都你六姐（上海控江旭辉店）面试',
            },
          },
        },
      ],
    });
    mockGeocodingService.geocode.mockResolvedValue({
      formattedAddress: '上海市杨浦区控江路旭辉广场',
      latitude: 31.281,
      longitude: 121.53,
    });
    mockMessageSenderService.sendMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    const result = await executeTool(
      { jobId: 100, destination: 'store' },
      {
        activeBookingJobIds: [100],
        currentUserMessage: '高德地图查不到东方渔人码头店的位置，是否搞错了？',
      },
    );

    expect(result.success).toBe(true);
    expect(result.destination).toBe('interview');
    expect(result.addressConflict).toBe(true);
    expect(result._fixedReply).toContain('这次面试请去');
    expect(result._fixedReply).toContain('不要按工作门店地址前往面试');
    expect(mockGeocodingService.geocode).toHaveBeenCalledWith(
      '成都你六姐（上海控江旭辉店）',
      '上海市',
    );
    expect(mockMessageSenderService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: SendMessageType.LOCATION,
        payload: expect.objectContaining({
          address: '新店开业前在成都你六姐（上海控江旭辉店）面试',
          latitude: 31.281,
          longitude: 121.53,
        }),
      }),
    );
  });

  it('进行中预约下明确询问上班地址时仍可发工作门店', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        {
          ...makeJob(),
          interviewProcess: {
            firstInterview: { interviewAddress: '北京市丰台区另一个面试点' },
          },
        },
      ],
    });
    mockMessageSenderService.sendMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    const result = await executeTool(
      { jobId: 100, destination: 'store' },
      {
        activeBookingJobIds: [100],
        currentUserMessage: '我是想问入职后的上班地址在哪',
      },
    );

    expect(result.destination).toBe('store');
    expect(mockGeocodingService.geocode).not.toHaveBeenCalled();
    expect(result.sentAddress).toBe('北京市丰台区青塔西路 1 号');
  });

  it('异店面试地址无法地理编码时宁可转人工也不发工作门店', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        {
          ...makeJob(),
          interviewProcess: {
            firstInterview: {
              firstInterviewWay: '线下面试',
              interviewAddress: '新店开业前在另一家店面试',
            },
          },
        },
      ],
    });
    mockGeocodingService.geocode.mockResolvedValue(null);

    const result = await executeTool(
      { jobId: 100 },
      { activeBookingJobIds: [100], currentUserMessage: '面试地址怎么走' },
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.STORE_LOCATION_INTERVIEW_GEOCODE_FAILED);
    expect(result.fallbackTextSent).toBe(true);
    expect(mockMessageSenderService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: SendMessageType.TEXT,
        payload: expect.objectContaining({ text: expect.stringContaining('这次面试请去') }),
      }),
    );
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageType: SendMessageType.LOCATION }),
    );
  });

  it('线上面试即使残留 interviewAddress 也不得发送定位', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        {
          ...makeJob(),
          interviewProcess: {
            firstInterview: {
              firstInterviewWay: '线上面试',
              interviewAddress: '历史残留的某门店地址',
            },
          },
        },
      ],
    });

    const result = await executeTool(
      { jobId: 100, destination: 'interview' },
      { activeBookingJobIds: [100], currentUserMessage: '面试地址在哪里' },
    );

    expect(result.success).toBe(true);
    expect(result.locationNotRequired).toBe(true);
    expect(result.interviewMethod).toBe('线上面试');
    expect(result.interviewAddress).toBeNull();
    expect(result._fixedReply).toContain('不需要到门店');
    expect(mockGeocodingService.geocode).not.toHaveBeenCalled();
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
  });

  it('面试形式未明确时不得根据地址字段猜测为线下', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        {
          ...makeJob(),
          interviewProcess: {
            firstInterview: { interviewAddress: '某门店地址' },
          },
        },
      ],
    });

    const result = await executeTool(
      { jobId: 100, destination: 'interview' },
      { activeBookingJobIds: [100], currentUserMessage: '面试地址在哪里' },
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.STORE_LOCATION_UNAVAILABLE);
    expect(result.interviewMethod).toBeNull();
    expect(result.interviewAddress).toBeNull();
    expect(mockGeocodingService.geocode).not.toHaveBeenCalled();
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
  });
});

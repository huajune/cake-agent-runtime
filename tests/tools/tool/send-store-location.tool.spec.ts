import { buildSendStoreLocationTool } from '@tools/send-store-location.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { SendMessageType } from '@channels/wecom/message-sender/dto/send-message.dto';

describe('buildSendStoreLocationTool', () => {
  const mockSpongeService = {
    fetchJobs: jest.fn(),
  };

  const mockMessageSenderService = {
    sendMessage: jest.fn(),
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
    expect(mockSpongeService.fetchJobs).toHaveBeenCalledWith({
      jobIdList: [100],
      pageNum: 1,
      pageSize: 1,
      options: {
        includeBasicInfo: true,
      },
    });
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
    expect(result.errorType).toBe('missing_delivery_context');
    expect(mockSpongeService.fetchJobs).not.toHaveBeenCalled();
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
  });

  it('should append floor hint extracted from store address', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          storeInfo: {
            storeName: '上海置汇旭辉店',
            storeAddress:
              '上海市-浦东新区-张杨路2389弄1-2号LCM置汇旭辉广场B1层48-50号成都你六姐',
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
    expect(result.errorType).toBe('store_location_unavailable');
    expect(result.storeAddress).toBe('北京市丰台区青塔西路 1 号');
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
  });
});

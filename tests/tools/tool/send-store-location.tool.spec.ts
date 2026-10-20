import { buildSendStoreLocationTool } from '@tools/send-store-location.tool';
import type { RecommendedJobSummary } from '@resolution/job';
import { ToolBuildContext } from '@shared-types/tool.types';
import { SendMessageType } from '@channels/wecom/message-sender/dto/send-message.dto';
import { TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { createToolContext, mergeToolContext } from '../../helpers/tool-context.fixture';

interface LocationContextOverrides {
  token?: string;
  botImId?: string;
  imContactId?: string;
  imRoomId?: string;
  chatId?: string;
  activeBookingJobIds?: number[];
  candidatePool?: RecommendedJobSummary[];
  fetchedJobs?: RecommendedJobSummary[];
  confirmedBookingJobIds?: number[];
  currentFocusJob?: ToolBuildContext['archive']['currentFocusJob'];
  currentUserMessage?: string;
  messages?: unknown[];
}

describe('buildSendStoreLocationTool', () => {
  const mockSpongeService = {
    fetchJobs: jest.fn(),
  };

  const mockMessageSenderService = {
    sendMessage: jest.fn(),
  };

  const mockGeocodingService = {
    searchCandidates: jest.fn(),
  };

  const mockContext: ToolBuildContext = createToolContext({
    session: {
      userId: 'user-1',
      corpId: 'corp-1',
      sessionId: 'sess-1',
      botImId: 'bot-im-1',
      token: 'token-1',
      imContactId: 'contact-1',
      chatId: 'chat-1',
      apiType: 'enterprise',
    },
    archive: {
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
    },
  });

  const buildContext = (overrides: LocationContextOverrides = {}) => {
    const has = (key: keyof LocationContextOverrides) =>
      Object.prototype.hasOwnProperty.call(overrides, key);
    return mergeToolContext(mockContext, {
      session: {
        ...(has('token') ? { token: overrides.token } : {}),
        ...(has('botImId') ? { botImId: overrides.botImId } : {}),
        ...(has('imContactId') ? { imContactId: overrides.imContactId } : {}),
        ...(has('imRoomId') ? { imRoomId: overrides.imRoomId } : {}),
        ...(has('chatId') ? { chatId: overrides.chatId } : {}),
      },
      ledger: {
        jobs: {
          fetchedJobs: overrides.fetchedJobs ?? [],
          confirmedBookingJobIds: overrides.confirmedBookingJobIds,
        },
      },
      archive: {
        candidatePool: overrides.candidatePool ?? [],
        ...(overrides.activeBookingJobIds === undefined
          ? {}
          : { activeBookingJobIds: overrides.activeBookingJobIds }),
        ...(overrides.currentFocusJob === undefined
          ? {}
          : { currentFocusJob: overrides.currentFocusJob }),
      },
      turnInput: {
        ...(overrides.currentUserMessage === undefined
          ? {}
          : { currentUserMessage: overrides.currentUserMessage }),
        ...(overrides.messages === undefined ? {} : { messages: overrides.messages }),
      },
    });
  };

  const makeJob = (overrides: Record<string, unknown> = {}) => ({
    basicInfo: {
      jobId: 100,
      brandName: '必胜客',
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
    contextOverride: LocationContextOverrides = {},
  ) => {
    const builder = buildSendStoreLocationTool(
      mockSpongeService as any,
      mockMessageSenderService as any,
      mockGeocodingService as any,
    );
    const builtTool = builder(buildContext(contextOverride));
    return builtTool.execute(input as any, {
      toolCallId: 'test',
      context: {},
      messages: [],
      abortSignal: undefined as any,
    }) as any;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const referencedStore: RecommendedJobSummary = {
    jobId: 200,
    brandName: '肯德基',
    jobName: '服务员',
    storeName: '佛山-李苑雯-幸福里DT-GZ7001',
    cityName: '佛山市',
    regionName: null,
    laborForm: '兼职',
    salaryDesc: null,
    jobCategoryName: null,
  };

  it.each(['candidatePool', 'fetchedJobs'] as const)(
    'rejects the stale focus when the user names a coded store from %s before sending',
    async (poolKey) => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
      const result = await executeTool(
        {},
        {
          [poolKey]: [referencedStore],
          currentUserMessage: '幸福里那家发个定位',
        },
      );
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.STORE_LOCATION_JOB_REFERENCE_MISMATCH);
      expect(result.referencedJobs).toContainEqual(expect.objectContaining({ jobId: 200 }));
      expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
      expect(mockGeocodingService.searchCandidates).not.toHaveBeenCalled();
    },
  );

  it.each(['虹桥店', '必胜客虹桥店'])(
    'rejects an explicitly named store absent from the pool: %s',
    async (referenceText) => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
      const result = await executeTool(
        { jobId: 100, referenceText },
        { currentUserMessage: `${referenceText}定位发我` },
      );
      expect(result.errorType).toBe(TOOL_ERROR_TYPES.STORE_LOCATION_JOB_REFERENCE_MISMATCH);
      expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('accepts an exact named store and rejects a fabricated reference', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
    const rejected = await executeTool(
      { jobId: 100, referenceText: '青塔店' },
      { currentUserMessage: '虹桥店定位发我' },
    );
    expect(rejected.errorType).toBe(TOOL_ERROR_TYPES.STORE_LOCATION_JOB_REFERENCE_MISMATCH);
    const accepted = await executeTool(
      { jobId: 100, referenceText: '必胜客青塔店' },
      { currentUserMessage: '必胜客青塔店定位发我' },
    );
    expect(accepted.errorType).not.toBe(TOOL_ERROR_TYPES.STORE_LOCATION_JOB_REFERENCE_MISMATCH);
  });

  it('rejects a different store even within the same brand', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
    const result = await executeTool(
      { jobId: 100 },
      {
        candidatePool: [{ ...referencedStore, brandName: '必胜客' }],
        currentUserMessage: '幸福里那家在哪',
      },
    );
    expect(result.success).toBe(false);
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
  });

  it('does not choose a location when the named brand has multiple stores', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
    const result = await executeTool(
      { jobId: 100 },
      {
        candidatePool: [referencedStore, { ...referencedStore, jobId: 201, storeName: '另一门店' }],
        currentUserMessage: '发一下肯德基定位',
      },
    );
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.STORE_LOCATION_JOB_REFERENCE_MISMATCH);
    expect(result.referencedJobs).toHaveLength(2);
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
  });

  it('does not send a store that contradicts the explicitly named brand', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
    const result = await executeTool(
      { jobId: 100 },
      { candidatePool: [referencedStore], currentUserMessage: '肯德基青塔店的定位发我' },
    );
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.STORE_LOCATION_JOB_REFERENCE_MISMATCH);
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
  });

  it('same-turn booking followed by location failure keeps the booked handoff instruction', async () => {
    mockSpongeService.fetchJobs.mockRejectedValueOnce(new Error('upstream unavailable'));
    const result = await executeTool(
      { jobId: 100 },
      { confirmedBookingJobIds: [100], currentUserMessage: '面试地址发我' },
    );
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.STORE_LOCATION_SEND_FAILED);
    expect(result._replyInstruction).toContain('request_handoff(cannot_find_store)');
    expect(result._replyInstruction).not.toContain('用文字告知');
  });

  it('allows multiple jobs at the same confirmed physical store', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob()] });
    const target = mockContext.archive.currentFocusJob!;
    const result = await executeTool(
      { jobId: 100 },
      {
        candidatePool: [{ ...target, jobId: 101, cityName: null }],
        currentUserMessage: '青塔店的位置',
      },
    );
    expect(result.success).toBe(true);
    expect(mockMessageSenderService.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends the correctly referenced coded store and echoes its brand and store', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          jobId: 200,
          brandName: '肯德基',
          storeInfo: {
            storeName: referencedStore.storeName,
            storeCityName: '佛山市',
            storeAddress: '佛山市幸福里一楼',
            latitude: 23,
            longitude: 113,
          },
        }),
      ],
    });
    const result = await executeTool(
      { jobId: 200 },
      {
        candidatePool: [referencedStore],
        currentUserMessage: '幸福里那家发个定位',
      },
    );
    expect(result.success).toBe(true);
    expect(result._fixedReply).toContain('肯德基·佛山-李苑雯-幸福里DT-GZ7001');
    expect(mockMessageSenderService.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to an unrelated job returned by the upstream API', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJob({ jobId: 200 })] });
    const result = await executeTool({ jobId: 100 });
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.STORE_LOCATION_JOB_NOT_FOUND);
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    [false, '线下面试'],
    [true, '线下面试'],
    [false, 'AI面试'],
    [true, 'AI面试'],
    [false, '电话面试'],
    [true, '电话面试'],
    [false, '视频面试'],
    [true, '视频面试'],
    [false, null],
    [true, null],
  ] as const)(
    'uses booking=%s and interview=%s for workplace location wording',
    async (booked, method) => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          {
            ...makeJob(),
            interviewProcess: { firstInterview: { firstInterviewWay: method } },
          },
        ],
      });
      const result = await executeTool(
        { jobId: 100, destination: 'store' },
        {
          activeBookingJobIds: booked ? [100] : [],
          currentUserMessage: '想看看上班地址',
        },
      );
      expect(result.success).toBe(true);
      expect(result._fixedReply.includes('别走错')).toBe(booked && method === '线下面试');
      expect(result._fixedReply.includes('先报名约面')).toBe(!booked);
      if (method && method !== '线下面试') {
        expect(result._fixedReply).toContain('这岗是' + method + '，不用到店面试');
      }
      expect(mockMessageSenderService.sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it.each([[100], [200]])(
    'uses a same-turn successful booking only for its actual job %j',
    async (jobId) => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          {
            ...makeJob(),
            interviewProcess: { firstInterview: { firstInterviewWay: '线下面试' } },
          },
        ],
      });
      const result = await executeTool(
        { jobId: 100, destination: 'store' },
        {
          confirmedBookingJobIds: [jobId],
          currentUserMessage: '想看看上班地址',
        },
      );
      expect(result._fixedReply.includes('先报名约面')).toBe(jobId !== 100);
      expect(result._fixedReply.includes('别走错')).toBe(jobId === 100);
    },
  );

  it('should send location message for explicit jobId', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJob()],
    });
    mockMessageSenderService.sendMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(true);
    expect(result._fixedReply).toBe(
      '必胜客·青塔店：门店位置发你了，方便看距离；要去门店前得先报名约面，我帮你登记。',
    );
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

  it('golden（Phase 0 / 方案 11.5 B-3）：store 目的地坐标来自海绵 storeInfo 直传，不经 geocode 复核', async () => {
    // badcase 0m4zs1h6（chat 6a4dcef8ce406a6aeec56fd8）排查结论：发给候选人的错误
    // 定位坐标 (121.511937, 31.239212) 正是海绵门店数据 storeInfo 的原值（与上海中心
    // 大厦真实位置偏差约 800m），本工具按现状直传，选点排序（ranker）不参与 store
    // 分支——根因是门店坐标数据质量。本用例锁定"直传"现状：后续若引入坐标复核/
    // 纠偏，必须显式修改本基线并附带方案依据。
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJob({
          jobId: 528365,
          jobName: '成都你六姐-上海中心店（新店）-前厅服务员-兼职',
          storeInfo: {
            storeName: '上海中心店（新店）',
            storeAddress: '上海市浦东新区陆家嘴银城中路501号上海中心大厦',
            latitude: 31.239212,
            longitude: 121.511937,
          },
        }),
      ],
    });
    mockMessageSenderService.sendMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    const result = await executeTool({ jobId: 528365 });

    expect(result.success).toBe(true);
    expect(result.latitude).toBe(31.239212);
    expect(result.longitude).toBe(121.511937);
    expect(mockGeocodingService.searchCandidates).not.toHaveBeenCalled();
    expect(mockMessageSenderService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: SendMessageType.LOCATION,
        payload: expect.objectContaining({
          latitude: 31.239212,
          longitude: 121.511937,
          name: '上海中心店（新店）',
        }),
      }),
    );
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

  it.each(['delivery', 'fetch'])('校验前 %s 失败只能澄清，不能沿用旧岗位地址', async (failure) => {
    mockSpongeService.fetchJobs.mockRejectedValueOnce(new Error('upstream unavailable'));
    const result = await executeTool(
      { jobId: 100, referenceText: '幸福里' },
      {
        candidatePool: [referencedStore],
        currentUserMessage: '幸福里定位发我',
        ...(failure === 'delivery' ? { token: undefined } : {}),
      },
    );
    expect(result.success).toBe(false);
    expect(result._replyInstruction).toContain('澄清');
    expect(result._replyInstruction).toContain('禁止沿用旧焦点');
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
    // 未调用 fetch 的参数分支不能把 once 拒绝泄漏给下一例。
    mockSpongeService.fetchJobs.mockReset();
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
    expect(result._fixedReply).toContain('门店位置发你了');
    expect(result._fixedReply).not.toContain('别走错');
  });

  it('should fallback to plain reply when address has no floor hint', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJob()],
    });
    mockMessageSenderService.sendMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    const result = await executeTool({ jobId: 100 });

    expect(result.success).toBe(true);
    expect(result.floorHint).toBeNull();
    expect(result._fixedReply).toBe(
      '必胜客·青塔店：门店位置发你了，方便看距离；要去门店前得先报名约面，我帮你登记。',
    );
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
    mockGeocodingService.searchCandidates.mockResolvedValue([
      {
        formattedAddress: '上海市杨浦区控江路旭辉广场',
        province: '上海市',
        city: '上海市',
        district: '杨浦区',
        township: '',
        latitude: 31.281,
        longitude: 121.53,
        poiName: '成都你六姐（上海控江旭辉店）',
        typecode: '050100',
        source: 'poi',
        precision: 'poi',
        confidence: 'high',
      },
    ]);
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
    expect(mockGeocodingService.searchCandidates).toHaveBeenCalledWith(
      '成都你六姐（上海控江旭辉店）',
      '上海市',
      5,
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

  it('同工作地址应继承门店 POI，不得地理编码语义文本', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        {
          ...makeJob({
            storeInfo: {
              storeName: '上海899广场店',
              storeAddress: '上海市静安区万航渡路889号889广场',
              storeCityName: '上海市',
              latitude: 31.229319650565213,
              longitude: 121.42866514121314,
            },
          }),
          interviewProcess: {
            firstInterview: {
              firstInterviewWay: '线下面试',
              interviewAddress: '同工作地址',
            },
          },
        },
      ],
    });
    mockMessageSenderService.sendMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    const result = await executeTool(
      { jobId: 100, destination: 'interview' },
      { activeBookingJobIds: [100], currentUserMessage: '面试地址怎么走' },
    );

    expect(result.success).toBe(true);
    expect(result.destination).toBe('interview');
    expect(result.interviewLocationSource).toBe('same_as_workplace');
    expect(result.addressConflict).toBe(false);
    expect(result.sentAddress).toBe('上海市静安区万航渡路889号889广场');
    expect(mockGeocodingService.searchCandidates).not.toHaveBeenCalled();
    expect(mockMessageSenderService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageType: SendMessageType.LOCATION,
        payload: expect.objectContaining({
          address: '上海市静安区万航渡路889号889广场',
          latitude: 31.229319650565213,
          longitude: 121.42866514121314,
        }),
      }),
    );
  });

  it('多个独立面试 POI 中只采用与地址锚点唯一匹配的高可信结果', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        {
          ...makeJob({
            storeInfo: {
              storeName: '上海东方渔人码头店',
              storeAddress: '上海东方渔人码头成都你六姐',
              storeCityName: '上海市',
              latitude: 31.25175342004096,
              longitude: 121.53239363958569,
            },
          }),
          interviewProcess: {
            firstInterview: {
              firstInterviewWay: '线下面试',
              interviewAddress: '新店开业前在成都你六姐（上海宝龙旭辉店）面试',
            },
          },
        },
      ],
    });
    mockGeocodingService.searchCandidates.mockResolvedValue([
      {
        formattedAddress: '上海市杨浦区宝龙旭辉广场成都你六姐上海宝龙旭辉店',
        province: '上海市',
        city: '上海市',
        district: '杨浦区',
        township: '',
        latitude: 31.27,
        longitude: 121.53,
        poiName: '成都你六姐（上海宝龙旭辉店）',
        typecode: '050100',
        source: 'poi',
        precision: 'poi',
        confidence: 'high',
      },
      {
        formattedAddress: '上海市浦东新区另一家成都你六姐',
        province: '上海市',
        city: '上海市',
        district: '浦东新区',
        township: '',
        latitude: 31.22,
        longitude: 121.6,
        poiName: '成都你六姐（另一家店）',
        typecode: '050100',
        source: 'poi',
        precision: 'poi',
        confidence: 'high',
      },
    ]);
    mockMessageSenderService.sendMessage.mockResolvedValue({ errcode: 0, errmsg: 'ok' });

    const result = await executeTool(
      { jobId: 100, destination: 'interview' },
      { activeBookingJobIds: [100], currentUserMessage: '发一下面试定位' },
    );

    expect(result.success).toBe(true);
    expect(result.interviewLocationSource).toBe('custom');
    expect(result.latitude).toBe(31.27);
    expect(result.longitude).toBe(121.53);
  });

  it('独立面试地址存在多个高可信但无法唯一匹配的 POI 时不得发送定位', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        {
          ...makeJob(),
          interviewProcess: {
            firstInterview: {
              firstInterviewWay: '线下面试',
              interviewAddress: '另一家面试门店',
            },
          },
        },
      ],
    });
    mockGeocodingService.searchCandidates.mockResolvedValue([
      {
        formattedAddress: '北京市丰台区甲门店',
        province: '北京市',
        city: '北京市',
        district: '丰台区',
        township: '',
        latitude: 39.8,
        longitude: 116.2,
        poiName: '甲门店',
        typecode: '050100',
        source: 'poi',
        precision: 'poi',
        confidence: 'high',
      },
      {
        formattedAddress: '北京市丰台区乙门店',
        province: '北京市',
        city: '北京市',
        district: '丰台区',
        township: '',
        latitude: 39.9,
        longitude: 116.3,
        poiName: '乙门店',
        typecode: '050100',
        source: 'poi',
        precision: 'poi',
        confidence: 'high',
      },
    ]);

    const result = await executeTool(
      { jobId: 100, destination: 'interview' },
      { activeBookingJobIds: [100], currentUserMessage: '面试地址怎么走' },
    );

    expect(result.success).toBe(false);
    expect(result.errorType).toBe(TOOL_ERROR_TYPES.STORE_LOCATION_INTERVIEW_GEOCODE_FAILED);
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageType: SendMessageType.LOCATION }),
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
    expect(mockGeocodingService.searchCandidates).not.toHaveBeenCalled();
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
    mockGeocodingService.searchCandidates.mockResolvedValue([]);

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

  it('视频面试即使残留 interviewAddress 也不得发送定位', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        {
          ...makeJob(),
          interviewProcess: {
            firstInterview: {
              firstInterviewWay: '视频面试',
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
    expect(result.interviewMethod).toBe('视频面试');
    expect(result.interviewAddress).toBeNull();
    expect(result._fixedReply).toContain('不需要到门店');
    expect(mockGeocodingService.searchCandidates).not.toHaveBeenCalled();
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
    expect(mockGeocodingService.searchCandidates).not.toHaveBeenCalled();
    expect(mockMessageSenderService.sendMessage).not.toHaveBeenCalled();
  });
});

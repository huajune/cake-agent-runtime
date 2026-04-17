import { Test, TestingModule } from '@nestjs/testing';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { MonitoringCacheService } from '@biz/monitoring/services/tracking/monitoring-cache.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { MonitoringErrorLogRepository } from '@biz/monitoring/repositories/error-log.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { ScenarioType } from '@enums/agent.enum';

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('MessageTrackingService', () => {
  let service: MessageTrackingService;
  let messageProcessingService: jest.Mocked<MessageProcessingService>;
  let errorLogRepository: jest.Mocked<MonitoringErrorLogRepository>;
  let userHostingService: jest.Mocked<UserHostingService>;
  let cacheService: jest.Mocked<MonitoringCacheService>;
  let activeRequests = 0;
  let peakActiveRequests = 0;

  const mockMessageProcessingService = {
    saveRecord: jest.fn().mockResolvedValue(true),
    getMessageProcessingRecordById: jest.fn().mockResolvedValue(null),
  };

  const mockErrorLogRepository = {
    saveErrorLog: jest.fn().mockResolvedValue(undefined),
  };

  const mockUserHostingService = {
    upsertActivity: jest.fn().mockResolvedValue(undefined),
  };

  const mockCacheService = {
    incrementCounter: jest.fn().mockResolvedValue(undefined),
    incrementCounters: jest.fn().mockResolvedValue(undefined),
    incrementActiveRequests: jest.fn(),
    getActiveRequests: jest.fn(),
    getPeakActiveRequests: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageTrackingService,
        {
          provide: MessageProcessingService,
          useValue: mockMessageProcessingService,
        },
        {
          provide: MonitoringErrorLogRepository,
          useValue: mockErrorLogRepository,
        },
        {
          provide: UserHostingService,
          useValue: mockUserHostingService,
        },
        {
          provide: MonitoringCacheService,
          useValue: mockCacheService,
        },
      ],
    }).compile();

    service = module.get(MessageTrackingService);
    messageProcessingService = module.get(MessageProcessingService);
    errorLogRepository = module.get(MonitoringErrorLogRepository);
    userHostingService = module.get(UserHostingService);
    cacheService = module.get(MonitoringCacheService);

    jest.clearAllMocks();
    activeRequests = 0;
    peakActiveRequests = 0;
    mockMessageProcessingService.saveRecord.mockResolvedValue(true);
    mockMessageProcessingService.getMessageProcessingRecordById.mockResolvedValue(null);
    mockErrorLogRepository.saveErrorLog.mockResolvedValue(undefined);
    mockUserHostingService.upsertActivity.mockResolvedValue(undefined);
    mockCacheService.incrementCounter.mockResolvedValue(undefined);
    mockCacheService.incrementCounters.mockResolvedValue(undefined);
    mockCacheService.incrementActiveRequests.mockImplementation(async (delta: number = 1) => {
      activeRequests = Math.max(activeRequests + delta, 0);
      peakActiveRequests = Math.max(peakActiveRequests, activeRequests);
      return activeRequests;
    });
    mockCacheService.getActiveRequests.mockImplementation(async () => activeRequests);
    mockCacheService.getPeakActiveRequests.mockImplementation(async () => peakActiveRequests);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should save a processing record immediately on message received', async () => {
    service.recordMessageReceived('msg-1', 'chat-1', 'user-1', 'User One', 'Hello World');

    await flushPromises();

    expect(await service.getActiveRequests()).toBe(1);
    expect(messageProcessingService.saveRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-1',
        chatId: 'chat-1',
        userId: 'user-1',
        userName: 'User One',
        status: 'processing',
        messagePreview: 'Hello World',
      }),
    );
    expect(cacheService.incrementCounter).toHaveBeenCalledWith('totalMessages', 1);
    expect(cacheService.incrementActiveRequests).toHaveBeenCalledWith(1);
    expect(userHostingService.upsertActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        odId: 'user-1',
        odName: 'User One',
        messageCount: 1,
        totalTokens: 0,
      }),
    );
  });

  it('should rebuild a success record from agentInvocation timings instead of pending in-memory state', async () => {
    service.recordMessageReceived('msg-1', 'chat-1', 'user-1', 'User One', '上海杨浦肯德基');
    await flushPromises();
    jest.clearAllMocks();

    mockMessageProcessingService.getMessageProcessingRecordById.mockResolvedValue({
      messageId: 'msg-1',
      chatId: 'chat-1',
      userId: 'user-1',
      userName: 'User One',
      receivedAt: 1000,
      status: 'processing',
      messagePreview: '上海杨浦肯德基',
    });

    service.recordSuccess('msg-1', {
      scenario: ScenarioType.CANDIDATE_CONSULTATION,
      tokenUsage: 200,
      replyPreview: '杨浦这边有两家门店在招。',
      replySegments: 2,
      toolCalls: [
        {
          toolName: 'duliday_job_list',
          args: {},
          resultCount: 7,
          status: 'ok',
        },
      ],
      agentInvocation: {
        request: {
          messageId: 'msg-1',
          chatId: 'chat-1',
          userId: 'user-1',
          userName: 'User One',
          managerName: 'bot-1',
          scenario: 'candidate-consultation',
          content: '上海杨浦肯德基',
          acceptedAt: 1000,
          batchId: 'batch-1',
          agentRequest: {
            messages: [{ role: 'user', content: '上海杨浦肯德基' }],
          },
        },
        response: {
          timings: {
            timestamps: {
              acceptedAt: 1000,
              aiStartAt: 3000,
              aiEndAt: 7000,
            },
            durations: {
              acceptedToWorkerStartMs: 1500,
              workerStartToAiStartMs: 500,
              aiStartToAiEndMs: 4000,
              deliveryDurationMs: 1200,
              totalMs: 8500,
            },
          },
          reply: {
            content: '杨浦这边有两家门店在招。',
            usage: { totalTokens: 200 },
          },
        },
        isFallback: false,
      },
    });

    await flushPromises();

    expect(messageProcessingService.saveRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-1',
        chatId: 'chat-1',
        status: 'success',
        scenario: ScenarioType.CANDIDATE_CONSULTATION,
        totalDuration: 8500,
        queueDuration: 1500,
        prepDuration: 500,
        aiStartAt: 3000,
        aiEndAt: 7000,
        aiDuration: 4000,
        sendDuration: 1200,
        tokenUsage: 200,
        toolCalls: [
          expect.objectContaining({ toolName: 'duliday_job_list', resultCount: 7, status: 'ok' }),
        ],
        replyPreview: '杨浦这边有两家门店在招。',
        replySegments: 2,
        batchId: 'batch-1',
      }),
    );
    expect(cacheService.incrementCounters).toHaveBeenCalledWith(
      expect.objectContaining({ totalSuccess: 1 }),
    );
    expect(cacheService.incrementCounter).toHaveBeenCalledWith('totalAiDuration', 4000);
    expect(cacheService.incrementCounter).toHaveBeenCalledWith('totalSendDuration', 1200);
    expect(cacheService.incrementActiveRequests).toHaveBeenLastCalledWith(-1);
    expect(await service.getActiveRequests()).toBe(0);
    expect(userHostingService.upsertActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        totalTokens: 200,
      }),
    );
  });

  it('should persist alertType on failure terminal records', async () => {
    mockMessageProcessingService.getMessageProcessingRecordById.mockResolvedValue({
      messageId: 'msg-failure',
      chatId: 'chat-1',
      receivedAt: 1000,
      status: 'processing',
    });

    service.recordFailure('msg-failure', 'agent failed', {
      alertType: 'agent',
      scenario: ScenarioType.CANDIDATE_CONSULTATION,
      agentInvocation: {
        request: {
          messageId: 'msg-failure',
          chatId: 'chat-1',
          acceptedAt: 1000,
        },
        response: {
          error: 'agent failed',
          timings: {
            timestamps: {
              acceptedAt: 1000,
            },
            durations: {
              totalMs: 3000,
            },
          },
        },
        isFallback: false,
      },
    });

    await flushPromises();

    expect(messageProcessingService.saveRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-failure',
        status: 'failure',
        alertType: 'agent',
      }),
    );
  });
  it('should still finalize a success record when only agentInvocation has the request context', async () => {
    service.recordSuccess('batch-1', {
      scenario: ScenarioType.CANDIDATE_CONSULTATION,
      agentInvocation: {
        request: {
          messageId: 'batch-1',
          chatId: 'chat-merged',
          userId: 'user-merged',
          userName: 'Merged User',
          content: '第一句\n第二句',
          acceptedAt: 2000,
          batchId: 'batch-1',
        },
        response: {
          timings: {
            timestamps: {
              acceptedAt: 2000,
            },
            durations: {
              totalMs: 6000,
            },
          },
          reply: {
            content: '我看到了，你继续说。',
          },
        },
        isFallback: false,
      },
    });

    await flushPromises();

    expect(messageProcessingService.saveRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'batch-1',
        chatId: 'chat-merged',
        status: 'success',
        messagePreview: '第一句\n第二句',
        totalDuration: 6000,
      }),
    );
  });

  it('should write failure records from agentInvocation and save an error log', async () => {
    service.recordMessageReceived('msg-2', 'chat-2', 'user-2', 'User Two', '我不满意');
    await flushPromises();
    jest.clearAllMocks();

    mockMessageProcessingService.getMessageProcessingRecordById.mockResolvedValue({
      messageId: 'msg-2',
      chatId: 'chat-2',
      userId: 'user-2',
      userName: 'User Two',
      receivedAt: 5000,
      status: 'processing',
      messagePreview: '我不满意',
    });

    service.recordFailure('msg-2', 'Agent 调用失败', {
      alertType: 'agent',
      scenario: ScenarioType.CANDIDATE_CONSULTATION,
      isFallback: true,
      fallbackSuccess: true,
      agentInvocation: {
        request: {
          messageId: 'msg-2',
          chatId: 'chat-2',
          userId: 'user-2',
          userName: 'User Two',
          acceptedAt: 5000,
          content: '我不满意',
        },
        response: {
          error: 'Agent 调用失败',
          fallback: { success: true },
          timings: {
            timestamps: {
              acceptedAt: 5000,
              aiStartAt: 6000,
              aiEndAt: 9000,
            },
            durations: {
              acceptedToWorkerStartMs: 400,
              workerStartToAiStartMs: 600,
              aiStartToAiEndMs: 3000,
              deliveryDurationMs: 800,
              totalMs: 5200,
            },
          },
        },
        isFallback: true,
      },
    });

    await flushPromises();

    expect(errorLogRepository.saveErrorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-2',
        error: 'Agent 调用失败',
        alertType: 'agent',
      }),
    );
    expect(messageProcessingService.saveRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-2',
        chatId: 'chat-2',
        status: 'failure',
        error: 'Agent 调用失败',
        totalDuration: 5200,
        aiDuration: 3000,
        sendDuration: 800,
        isFallback: true,
        fallbackSuccess: true,
      }),
    );
    expect(cacheService.incrementCounters).toHaveBeenCalledWith(
      expect.objectContaining({
        totalFailure: 1,
        totalFallback: 1,
        totalFallbackSuccess: 1,
      }),
    );
    expect(await service.getActiveRequests()).toBe(0);
  });

  it('should skip terminal persistence when neither DB row nor agentInvocation request context exists', async () => {
    service.recordSuccess('missing-msg');

    await flushPromises();

    expect(messageProcessingService.saveRecord).not.toHaveBeenCalled();
    expect(cacheService.incrementCounters).not.toHaveBeenCalled();
    expect(await service.getActiveRequests()).toBe(0);
  });
});

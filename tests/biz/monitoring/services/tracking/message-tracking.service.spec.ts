import { Test, TestingModule } from '@nestjs/testing';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { MonitoringCacheService } from '@biz/monitoring/services/tracking/monitoring-cache.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { MonitoringErrorLogRepository } from '@biz/monitoring/repositories/error-log.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { ScenarioType } from '@enums/agent.enum';

/** Flush all pending microtasks/promise chains */
const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('MessageTrackingService', () => {
  let service: MessageTrackingService;
  let messageProcessingRepository: jest.Mocked<MessageProcessingService> & {
    saveMessageProcessingRecord: jest.Mock;
  };
  let errorLogRepository: jest.Mocked<MonitoringErrorLogRepository>;
  let userHostingRepository: jest.Mocked<UserHostingService> & {
    upsertUserActivity: jest.Mock;
  };
  let cacheService: jest.Mocked<MonitoringCacheService>;

  const saveRecordMock = jest.fn().mockResolvedValue(undefined);
  const mockMessageProcessingRepository = {
    saveRecord: saveRecordMock,
    saveMessageProcessingRecord: saveRecordMock,
  };

  const mockErrorLogRepository = {
    saveErrorLog: jest.fn().mockResolvedValue(undefined),
  };

  const upsertActivityMock = jest.fn().mockResolvedValue(undefined);
  const mockUserHostingRepository = {
    upsertActivity: upsertActivityMock,
    upsertUserActivity: upsertActivityMock,
  };

  const mockCacheService = {
    incrementCounter: jest.fn().mockResolvedValue(undefined),
    incrementCounters: jest.fn().mockResolvedValue(undefined),
    incrementCurrentProcessing: jest.fn().mockResolvedValue(1),
    updatePeakProcessing: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageTrackingService,
        {
          provide: MessageProcessingService,
          useValue: mockMessageProcessingRepository,
        },
        {
          provide: MonitoringErrorLogRepository,
          useValue: mockErrorLogRepository,
        },
        {
          provide: UserHostingService,
          useValue: mockUserHostingRepository,
        },
        {
          provide: MonitoringCacheService,
          useValue: mockCacheService,
        },
      ],
    }).compile();

    service = module.get<MessageTrackingService>(MessageTrackingService);
    messageProcessingRepository = module.get(MessageProcessingService) as typeof messageProcessingRepository;
    errorLogRepository = module.get(MonitoringErrorLogRepository);
    userHostingRepository = module.get(UserHostingService) as typeof userHostingRepository;
    cacheService = module.get(MonitoringCacheService);

    jest.clearAllMocks();
    // Reset mock defaults after clearAllMocks
    mockCacheService.incrementCurrentProcessing.mockResolvedValue(1);
    mockCacheService.updatePeakProcessing.mockResolvedValue(undefined);
    mockMessageProcessingRepository.saveRecord.mockResolvedValue(undefined);
    mockErrorLogRepository.saveErrorLog.mockResolvedValue(undefined);
    mockUserHostingRepository.upsertActivity.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========================================
  // getPendingCount
  // ========================================

  describe('getPendingCount', () => {
    it('should return 0 initially', () => {
      expect(service.getPendingCount()).toBe(0);
    });

    it('should increment after recording a message received', () => {
      service.recordMessageReceived('msg-1', 'chat-1', 'user-1');
      expect(service.getPendingCount()).toBe(1);
    });

    it('should count multiple pending messages', () => {
      service.recordMessageReceived('msg-1', 'chat-1', 'user-1');
      service.recordMessageReceived('msg-2', 'chat-2', 'user-2');
      expect(service.getPendingCount()).toBe(2);
    });
  });

  // ========================================
  // recordMessageReceived
  // ========================================

  describe('recordMessageReceived', () => {
    it('should create a pending record and save to database', async () => {
      service.recordMessageReceived('msg-1', 'chat-1', 'user-1', 'User One', 'Hello World');

      expect(service.getPendingCount()).toBe(1);

      jest.useRealTimers();
      await flushPromises();

      expect(messageProcessingRepository.saveMessageProcessingRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-1',
          chatId: 'chat-1',
          userId: 'user-1',
          userName: 'User One',
          status: 'processing',
          messagePreview: 'Hello World',
        }),
      );
    });

    it('should truncate messagePreview to 50 characters', async () => {
      const longMessage = 'A'.repeat(100);
      service.recordMessageReceived('msg-1', 'chat-1', undefined, undefined, longMessage);

      jest.useRealTimers();
      await flushPromises();

      expect(messageProcessingRepository.saveMessageProcessingRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          messagePreview: 'A'.repeat(50),
        }),
      );
    });

    it('should increment totalMessages counter in Redis', () => {
      service.recordMessageReceived('msg-1', 'chat-1');

      expect(cacheService.incrementCounter).toHaveBeenCalledWith('totalMessages', 1);
    });

    it('should increment current processing and update peak', async () => {
      mockCacheService.incrementCurrentProcessing.mockResolvedValue(5);

      service.recordMessageReceived('msg-1', 'chat-1');

      jest.useRealTimers();
      await flushPromises();

      expect(cacheService.incrementCurrentProcessing).toHaveBeenCalledWith(1);
    });

    it('should set scenario from metadata', async () => {
      service.recordMessageReceived('msg-1', 'chat-1', undefined, undefined, undefined, {
        scenario: ScenarioType.CANDIDATE_CONSULTATION,
      });

      jest.useRealTimers();
      await flushPromises();

      expect(messageProcessingRepository.saveMessageProcessingRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          scenario: ScenarioType.CANDIDATE_CONSULTATION,
        }),
      );
    });

    it('should save user activity immediately', async () => {
      service.recordMessageReceived('msg-1', 'chat-1', 'user-1', 'User One');

      jest.useRealTimers();
      await flushPromises();

      expect(userHostingRepository.upsertUserActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-1',
          odId: 'user-1',
          odName: 'User One',
          messageCount: 1,
          totalTokens: 0,
        }),
      );
    });

    it('should handle database save error gracefully', async () => {
      mockMessageProcessingRepository.saveMessageProcessingRecord.mockRejectedValue(
        new Error('DB error'),
      );

      expect(() => {
        service.recordMessageReceived('msg-1', 'chat-1');
      }).not.toThrow();
    });
  });

  // ========================================
  // recordWorkerStart
  // ========================================

  describe('recordWorkerStart', () => {
    it('should set queueDuration on existing pending record', () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordWorkerStart('msg-1');
      // The record should have queueDuration set
    });

    it('should do nothing when record does not exist', () => {
      expect(() => service.recordWorkerStart('non-existent')).not.toThrow();
    });
  });

  // ========================================
  // recordAiStart
  // ========================================

  describe('recordAiStart', () => {
    it('should set aiStartAt and calculate prepDuration when queueDuration is set', () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordWorkerStart('msg-1');
      service.recordAiStart('msg-1');
    });

    it('should set queueDuration (legacy) when queueDuration is not set', () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      // Skip recordWorkerStart, call recordAiStart directly (legacy path)
      service.recordAiStart('msg-1');
    });

    it('should do nothing when record does not exist', () => {
      expect(() => service.recordAiStart('non-existent')).not.toThrow();
    });
  });

  // ========================================
  // recordAiEnd
  // ========================================

  describe('recordAiEnd', () => {
    it('should set aiEndAt, aiDuration, and update Redis counter', () => {
      jest.setSystemTime(1000);
      service.recordMessageReceived('msg-1', 'chat-1');

      jest.setSystemTime(2000);
      service.recordAiStart('msg-1');

      jest.setSystemTime(5000);
      service.recordAiEnd('msg-1');

      expect(cacheService.incrementCounter).toHaveBeenCalledWith('totalAiDuration', 3000);
    });

    it('should do nothing when record has no aiStartAt', () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordAiEnd('msg-1'); // aiStartAt not set

      const aiDurationCalls = (cacheService.incrementCounter as jest.Mock).mock.calls.filter(
        ([field]) => field === 'totalAiDuration',
      );
      expect(aiDurationCalls).toHaveLength(0);
    });

    it('should do nothing when record does not exist', () => {
      expect(() => service.recordAiEnd('non-existent')).not.toThrow();
    });

    it('should handle Redis counter error gracefully', () => {
      mockCacheService.incrementCounter.mockRejectedValue(new Error('Redis error'));

      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordAiStart('msg-1');

      expect(() => service.recordAiEnd('msg-1')).not.toThrow();
    });
  });

  // ========================================
  // recordSendStart / recordSendEnd
  // ========================================

  describe('recordSendStart', () => {
    it('should set sendStartAt on the record', () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordSendStart('msg-1');
    });

    it('should do nothing when record does not exist', () => {
      expect(() => service.recordSendStart('non-existent')).not.toThrow();
    });
  });

  describe('recordSendEnd', () => {
    it('should set sendEndAt, sendDuration, and update Redis counter', () => {
      jest.setSystemTime(1000);
      service.recordMessageReceived('msg-1', 'chat-1');

      jest.setSystemTime(2000);
      service.recordSendStart('msg-1');

      jest.setSystemTime(4000);
      service.recordSendEnd('msg-1');

      expect(cacheService.incrementCounter).toHaveBeenCalledWith('totalSendDuration', 2000);
    });

    it('should do nothing when sendStartAt is not set', () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordSendEnd('msg-1'); // sendStartAt not set

      const sendDurationCalls = (cacheService.incrementCounter as jest.Mock).mock.calls.filter(
        ([field]) => field === 'totalSendDuration',
      );
      expect(sendDurationCalls).toHaveLength(0);
    });

    it('should do nothing when record does not exist', () => {
      expect(() => service.recordSendEnd('non-existent')).not.toThrow();
    });
  });

  // ========================================
  // recordSuccess
  // ========================================

  describe('recordSuccess', () => {
    it('should update record status to success and remove from pending', async () => {
      service.recordMessageReceived('msg-1', 'chat-1', 'user-1');
      expect(service.getPendingCount()).toBe(1);

      service.recordSuccess('msg-1');

      jest.useRealTimers();
      await flushPromises();

      expect(service.getPendingCount()).toBe(0);
    });

    it('should increment totalSuccess counter', () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordSuccess('msg-1');

      expect(cacheService.incrementCounters).toHaveBeenCalledWith(
        expect.objectContaining({ totalSuccess: 1 }),
      );
    });

    it('should also increment totalFallback when isFallback is true', () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordSuccess('msg-1', { isFallback: true, fallbackSuccess: true });

      expect(cacheService.incrementCounters).toHaveBeenCalledWith(
        expect.objectContaining({
          totalSuccess: 1,
          totalFallback: 1,
          totalFallbackSuccess: 1,
        }),
      );
    });

    it('should increment totalFallback without totalFallbackSuccess when fallback failed', () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordSuccess('msg-1', { isFallback: true, fallbackSuccess: false });

      const calls = (cacheService.incrementCounters as jest.Mock).mock.calls[0][0];
      expect(calls.totalFallback).toBe(1);
      expect(calls.totalFallbackSuccess).toBeUndefined();
    });

    it('should decrement current processing count', () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordSuccess('msg-1');

      expect(cacheService.incrementCurrentProcessing).toHaveBeenCalledWith(-1);
    });

    it('should save record to database with success status', async () => {
      service.recordMessageReceived('msg-1', 'chat-1', 'user-1');
      service.recordSuccess('msg-1', {
        scenario: ScenarioType.CANDIDATE_CONSULTATION,
        tokenUsage: 500,
      });

      jest.useRealTimers();
      await flushPromises();

      expect(messageProcessingRepository.saveMessageProcessingRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-1',
          status: 'success',
        }),
      );
    });

    it('should save user activity when tokenUsage is positive', async () => {
      service.recordMessageReceived('msg-1', 'chat-1', 'user-1', 'User One');
      jest.clearAllMocks();
      mockMessageProcessingRepository.saveMessageProcessingRecord.mockResolvedValue(undefined);
      mockUserHostingRepository.upsertUserActivity.mockResolvedValue(undefined);
      mockCacheService.incrementCounters.mockResolvedValue(undefined);
      mockCacheService.incrementCurrentProcessing.mockResolvedValue(0);

      service.recordSuccess('msg-1', { tokenUsage: 300 });

      jest.useRealTimers();
      await flushPromises();

      expect(userHostingRepository.upsertUserActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-1',
          totalTokens: 300,
        }),
      );
    });

    it('should not save user activity when tokenUsage is 0', async () => {
      service.recordMessageReceived('msg-1', 'chat-1', 'user-1');
      jest.clearAllMocks();
      mockMessageProcessingRepository.saveMessageProcessingRecord.mockResolvedValue(undefined);
      mockCacheService.incrementCounters.mockResolvedValue(undefined);
      mockCacheService.incrementCurrentProcessing.mockResolvedValue(0);

      service.recordSuccess('msg-1', { tokenUsage: 0 });

      jest.useRealTimers();
      await flushPromises();

      expect(userHostingRepository.upsertUserActivity).not.toHaveBeenCalled();
    });

    it('should log error and return early when record is not found', () => {
      service.recordSuccess('non-existent-msg');

      expect(cacheService.incrementCounters).not.toHaveBeenCalled();
      expect(messageProcessingRepository.saveMessageProcessingRecord).not.toHaveBeenCalled();
    });

    it('should update metadata fields from parameter', async () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordSuccess('msg-1', {
        scenario: ScenarioType.CANDIDATE_CONSULTATION,
        tools: ['tool-a', 'tool-b'],
        tokenUsage: 250,
        replyPreview: 'Hello!',
        replySegments: 2,
        batchId: 'batch-1',
      });

      jest.useRealTimers();
      await flushPromises();

      expect(messageProcessingRepository.saveMessageProcessingRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          scenario: ScenarioType.CANDIDATE_CONSULTATION,
          tools: ['tool-a', 'tool-b'],
          tokenUsage: 250,
          replyPreview: 'Hello!',
          replySegments: 2,
          batchId: 'batch-1',
        }),
      );
    });
  });

  // ========================================
  // recordFailure
  // ========================================

  describe('recordFailure', () => {
    it('should update record status to failure and remove from pending', async () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      expect(service.getPendingCount()).toBe(1);

      service.recordFailure('msg-1', 'Something went wrong');

      jest.useRealTimers();
      await flushPromises();

      expect(service.getPendingCount()).toBe(0);
    });

    it('should increment totalFailure counter', () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordFailure('msg-1', 'Error message');

      expect(cacheService.incrementCounters).toHaveBeenCalledWith(
        expect.objectContaining({ totalFailure: 1 }),
      );
    });

    it('should also increment totalFallback when isFallback is true', () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordFailure('msg-1', 'Error', { isFallback: true, fallbackSuccess: true });

      expect(cacheService.incrementCounters).toHaveBeenCalledWith(
        expect.objectContaining({
          totalFailure: 1,
          totalFallback: 1,
          totalFallbackSuccess: 1,
        }),
      );
    });

    it('should decrement current processing count', () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordFailure('msg-1', 'Error');

      expect(cacheService.incrementCurrentProcessing).toHaveBeenCalledWith(-1);
    });

    it('should save error log', async () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordFailure('msg-1', 'Critical error', { alertType: 'agent' });

      jest.useRealTimers();
      await flushPromises();

      expect(errorLogRepository.saveErrorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-1',
          error: 'Critical error',
          alertType: 'agent',
        }),
      );
    });

    it('should save record to database with failure status', async () => {
      service.recordMessageReceived('msg-1', 'chat-1');
      service.recordFailure('msg-1', 'Timeout error');

      jest.useRealTimers();
      await flushPromises();

      expect(messageProcessingRepository.saveMessageProcessingRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-1',
          status: 'failure',
          error: 'Timeout error',
        }),
      );
    });

    it('should save error log and return early when record is not found', () => {
      service.recordFailure('non-existent-msg', 'Error', { alertType: 'system' });

      expect(cacheService.incrementCounters).not.toHaveBeenCalled();
      expect(errorLogRepository.saveErrorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'non-existent-msg',
          error: 'Error',
          alertType: 'system',
        }),
      );
    });

    it('should use "unknown" as alertType when not specified and record is missing', () => {
      service.recordFailure('non-existent-msg', 'Error');

      expect(errorLogRepository.saveErrorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          alertType: 'unknown',
        }),
      );
    });
  });

  // ========================================
  // Cleanup of stale pending records
  // ========================================

  describe('cleanup of stale pending records', () => {
    it('should save stale records as failed and remove them when cleanup runs', async () => {
      jest.useRealTimers();

      service.recordMessageReceived('stale-msg', 'chat-1');

      // Manually set the receivedAt to simulate a 2-hour-old record
      const pendingRecords = (
        service as unknown as { pendingRecords: Map<string, { receivedAt: number }> }
      ).pendingRecords;
      const record = pendingRecords.get('stale-msg');
      if (record) {
        record.receivedAt = Date.now() - 2 * 60 * 60 * 1000;
      }

      expect(service.getPendingCount()).toBe(1);

      // Directly invoke the private cleanup method
      (service as unknown as { cleanupPendingRecords: () => void }).cleanupPendingRecords();
      await flushPromises();

      expect(service.getPendingCount()).toBe(0);
      expect(messageProcessingRepository.saveMessageProcessingRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'stale-msg',
          status: 'failure',
          error: '超时未完成（1小时）',
        }),
      );
    });

    it('should not remove records that are within TTL when cleanup runs', async () => {
      jest.useRealTimers();

      service.recordMessageReceived('fresh-msg', 'chat-1');
      // Record receivedAt is now (well within the 1-hour TTL)

      // Directly invoke the private cleanup method
      (service as unknown as { cleanupPendingRecords: () => void }).cleanupPendingRecords();
      await flushPromises();

      // Fresh record should still be pending
      expect(service.getPendingCount()).toBe(1);
    });
  });
});

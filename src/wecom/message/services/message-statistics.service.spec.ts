import { Test, TestingModule } from '@nestjs/testing';
import { MessageStatisticsService } from './message-statistics.service';
import { MessageDeduplicationService } from './message-deduplication.service';
import { MessageHistoryService } from './message-history.service';
import { SimpleMergeService } from './simple-merge.service';

describe('MessageStatisticsService', () => {
  let service: MessageStatisticsService;

  const mockDeduplicationService = {
    getStats: jest.fn(),
    clearAll: jest.fn(),
    cleanupExpiredMessages: jest.fn(),
  };

  const mockHistoryService = {
    getStats: jest.fn(),
    clearHistory: jest.fn(),
  };

  const mockSimpleMergeService = {
    getStats: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageStatisticsService,
        { provide: MessageDeduplicationService, useValue: mockDeduplicationService },
        { provide: MessageHistoryService, useValue: mockHistoryService },
        { provide: SimpleMergeService, useValue: mockSimpleMergeService },
      ],
    }).compile();

    service = module.get<MessageStatisticsService>(MessageStatisticsService);
    jest.clearAllMocks();

    mockDeduplicationService.getStats.mockReturnValue({ storage: 'redis', ttlSeconds: 300 });
    mockHistoryService.getStats.mockReturnValue({
      storageType: 'supabase',
      maxMessagesForContext: 60,
    });
    mockSimpleMergeService.getStats.mockReturnValue({ mergeDelayMs: 2000, maxMergedMessages: 5 });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getServiceStatus', () => {
    it('should return complete service status', () => {
      const result = service.getServiceStatus(2, 10, true, true, true);

      expect(result).toMatchObject({
        processingCount: 2,
        maxConcurrentProcessing: 10,
        aiReplyEnabled: true,
        messageMergeEnabled: true,
        messageSplitSendEnabled: true,
      });
      expect(result.dedupeCache).toBeDefined();
      expect(result.historyCache).toBeDefined();
    });

    it('should reflect disabled states correctly', () => {
      const result = service.getServiceStatus(0, 0, false, false, false);

      expect(result.aiReplyEnabled).toBe(false);
      expect(result.messageMergeEnabled).toBe(false);
      expect(result.messageSplitSendEnabled).toBe(false);
      expect(result.processingCount).toBe(0);
    });
  });

  describe('getCacheStats', () => {
    it('should return detailed cache stats with utilization', () => {
      const result = service.getCacheStats(5, 10);

      expect(result).toMatchObject({
        processing: {
          currentCount: 5,
          maxConcurrent: 10,
          utilizationPercent: 50,
        },
      });
      expect(result.messageDeduplication).toBeDefined();
      expect(result.conversationHistory).toBeDefined();
      expect(result.messageMergeQueues).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });

    it('should return 0 utilization when maxConcurrent is 0 to avoid division by zero', () => {
      const result = service.getCacheStats(3, 0);

      expect(result.processing.utilizationPercent).toBe(0);
    });

    it('should calculate correct utilization percentage', () => {
      const result = service.getCacheStats(3, 12);

      expect(result.processing.utilizationPercent).toBeCloseTo(25);
    });
  });

  describe('clearCache', () => {
    it('should clear all caches by default when no options provided', async () => {
      mockDeduplicationService.clearAll.mockResolvedValue(undefined);
      mockHistoryService.clearHistory.mockResolvedValue(0);

      const result = await service.clearCache();

      expect(mockDeduplicationService.clearAll).toHaveBeenCalled();
      expect(mockHistoryService.clearHistory).toHaveBeenCalled();
      expect(result.cleared.deduplication).toBe(true);
      expect(result.cleared.history).toBe(true);
      expect(result.cleared.mergeQueues).toBe(true);
    });

    it('should only clear deduplication when deduplication=true', async () => {
      mockDeduplicationService.clearAll.mockResolvedValue(undefined);

      const result = await service.clearCache({ deduplication: true });

      expect(mockDeduplicationService.clearAll).toHaveBeenCalled();
      expect(mockHistoryService.clearHistory).not.toHaveBeenCalled();
      expect(result.cleared.deduplication).toBe(true);
      expect(result.cleared.history).toBe(false);
    });

    it('should clear history for specific chatId when provided', async () => {
      mockHistoryService.clearHistory.mockResolvedValue(0);

      const result = await service.clearCache({ history: true, chatId: 'chat-123' });

      expect(mockHistoryService.clearHistory).toHaveBeenCalledWith('chat-123');
      expect(result.cleared.history).toBe(true);
    });

    it('should mark mergeQueues as cleared (managed by Redis TTL)', async () => {
      const result = await service.clearCache({ mergeQueues: true });

      expect(result.cleared.mergeQueues).toBe(true);
    });

    it('should include timestamp in result', async () => {
      const result = await service.clearCache({});

      expect(result.timestamp).toBeDefined();
      expect(typeof result.timestamp).toBe('string');
    });
  });

  describe('performScheduledCleanup', () => {
    it('should call cleanupExpiredMessages and return cleanup result', () => {
      mockDeduplicationService.cleanupExpiredMessages.mockReturnValue(5);

      const result = service.performScheduledCleanup();

      expect(mockDeduplicationService.cleanupExpiredMessages).toHaveBeenCalled();
      expect(result.dedupe.cleanedMessages).toBe(5);
      expect(result.history.note).toBe('Redis TTL 自动清理');
      expect(result.timestamp).toBeDefined();
    });

    it('should return 0 cleaned messages when Redis TTL manages cleanup', () => {
      mockDeduplicationService.cleanupExpiredMessages.mockReturnValue(0);

      const result = service.performScheduledCleanup();

      expect(result.dedupe.cleanedMessages).toBe(0);
    });
  });
});

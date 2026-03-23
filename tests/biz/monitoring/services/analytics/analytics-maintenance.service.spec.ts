import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsMaintenanceService } from '@biz/monitoring/services/analytics/analytics-maintenance.service';
import { MonitoringCacheService } from '@biz/monitoring/services/tracking/monitoring-cache.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { MonitoringHourlyStatsRepository } from '@biz/monitoring/repositories/hourly-stats.repository';
import { MonitoringErrorLogRepository } from '@biz/monitoring/repositories/error-log.repository';
import { MonitoringRecordRepository } from '@biz/monitoring/repositories/record.repository';

describe('AnalyticsMaintenanceService', () => {
  let service: AnalyticsMaintenanceService;
  let messageProcessingRepository: jest.Mocked<MessageProcessingService>;
  let hourlyStatsRepository: jest.Mocked<MonitoringHourlyStatsRepository>;
  let errorLogRepository: jest.Mocked<MonitoringErrorLogRepository>;
  let cacheService: jest.Mocked<MonitoringCacheService>;
  let monitoringRepository: jest.Mocked<MonitoringRecordRepository>;

  const mockMessageProcessingRepository = {
    clearAllRecords: jest.fn(),
  };

  const mockHourlyStatsRepository = {
    clearAllRecords: jest.fn(),
    saveHourlyStats: jest.fn(),
  };

  const mockErrorLogRepository = {
    clearAllRecords: jest.fn(),
  };

  const mockCacheService = {
    resetCounters: jest.fn(),
    clearAll: jest.fn(),
  };

  const mockMonitoringRecordRepository = {
    aggregateHourlyStats: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsMaintenanceService,
        {
          provide: MessageProcessingService,
          useValue: mockMessageProcessingRepository,
        },
        {
          provide: MonitoringHourlyStatsRepository,
          useValue: mockHourlyStatsRepository,
        },
        {
          provide: MonitoringErrorLogRepository,
          useValue: mockErrorLogRepository,
        },
        {
          provide: MonitoringCacheService,
          useValue: mockCacheService,
        },
        {
          provide: MonitoringRecordRepository,
          useValue: mockMonitoringRecordRepository,
        },
      ],
    }).compile();

    service = module.get<AnalyticsMaintenanceService>(AnalyticsMaintenanceService);
    messageProcessingRepository = module.get(MessageProcessingService);
    hourlyStatsRepository = module.get(MonitoringHourlyStatsRepository);
    errorLogRepository = module.get(MonitoringErrorLogRepository);
    cacheService = module.get(MonitoringCacheService);
    monitoringRepository = module.get(MonitoringRecordRepository);

    jest.clearAllMocks();

    mockMessageProcessingRepository.clearAllRecords.mockResolvedValue(undefined);
    mockHourlyStatsRepository.clearAllRecords.mockResolvedValue(undefined);
    mockHourlyStatsRepository.saveHourlyStats.mockResolvedValue(undefined);
    mockErrorLogRepository.clearAllRecords.mockResolvedValue(undefined);
    mockCacheService.resetCounters.mockResolvedValue(undefined);
    mockCacheService.clearAll.mockResolvedValue(undefined);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========================================
  // clearAllDataAsync
  // ========================================

  describe('clearAllDataAsync', () => {
    it('should clear all three repositories in parallel and reset cache counters', async () => {
      await service.clearAllDataAsync();

      expect(messageProcessingRepository.clearAllRecords).toHaveBeenCalledTimes(1);
      expect(hourlyStatsRepository.clearAllRecords).toHaveBeenCalledTimes(1);
      expect(errorLogRepository.clearAllRecords).toHaveBeenCalledTimes(1);
      expect(cacheService.resetCounters).toHaveBeenCalledTimes(1);
    });

    it('should throw when a repository fails', async () => {
      mockMessageProcessingRepository.clearAllRecords.mockRejectedValue(new Error('DB error'));

      await expect(service.clearAllDataAsync()).rejects.toThrow('DB error');
    });

    it('should not call resetCounters when a repository throws', async () => {
      mockHourlyStatsRepository.clearAllRecords.mockRejectedValue(new Error('DB error'));

      await expect(service.clearAllDataAsync()).rejects.toThrow();
      expect(cacheService.resetCounters).not.toHaveBeenCalled();
    });
  });

  // ========================================
  // clearCacheAsync
  // ========================================

  describe('clearCacheAsync', () => {
    it('should reset counters and clear all when type is "all"', async () => {
      await service.clearCacheAsync('all');

      expect(cacheService.resetCounters).toHaveBeenCalledTimes(1);
      expect(cacheService.clearAll).toHaveBeenCalledTimes(1);
    });

    it('should only reset counters when type is "metrics"', async () => {
      await service.clearCacheAsync('metrics');

      expect(cacheService.resetCounters).toHaveBeenCalledTimes(1);
      expect(cacheService.clearAll).not.toHaveBeenCalled();
    });

    it('should only clear all when type is "history"', async () => {
      await service.clearCacheAsync('history');

      expect(cacheService.resetCounters).not.toHaveBeenCalled();
      expect(cacheService.clearAll).toHaveBeenCalledTimes(1);
    });

    it('should handle agent type (no-op, just logs)', async () => {
      await service.clearCacheAsync('agent');

      expect(cacheService.resetCounters).not.toHaveBeenCalled();
      expect(cacheService.clearAll).not.toHaveBeenCalled();
    });

    it('should default to "all" behavior when no type is specified', async () => {
      await service.clearCacheAsync();

      expect(cacheService.resetCounters).toHaveBeenCalledTimes(1);
      expect(cacheService.clearAll).toHaveBeenCalledTimes(1);
    });

    it('should throw when cache operation fails', async () => {
      mockCacheService.resetCounters.mockRejectedValue(new Error('Cache error'));

      await expect(service.clearCacheAsync('metrics')).rejects.toThrow('Cache error');
    });
  });

  // ========================================
  // aggregateHourlyStats
  // ========================================

  describe('aggregateHourlyStats', () => {
    it('should aggregate last hour stats and save to repository', async () => {
      const mockAggregated = {
        messageCount: 50,
        successCount: 45,
        failureCount: 5,
        successRate: 90,
        avgDuration: 5000,
        minDuration: 1000,
        maxDuration: 30000,
        p50Duration: 4000,
        p95Duration: 20000,
        p99Duration: 28000,
        avgAiDuration: 3000,
        avgSendDuration: 1500,
        activeUsers: 10,
        activeChats: 8,
        totalTokenUsage: 2500,
        fallbackCount: 2,
        fallbackSuccessCount: 1,
        scenarioStats: { job_consulting: { count: 30, successCount: 28, avgDuration: 5000 } },
        toolStats: { booking: 5 },
      };
      mockMonitoringRecordRepository.aggregateHourlyStats.mockResolvedValue(mockAggregated);

      await service.aggregateHourlyStats();

      expect(monitoringRepository.aggregateHourlyStats).toHaveBeenCalledWith(
        expect.any(Date),
        expect.any(Date),
      );
      expect(hourlyStatsRepository.saveHourlyStats).toHaveBeenCalledWith(
        expect.objectContaining({
          messageCount: 50,
          successCount: 45,
          failureCount: 5,
          successRate: 90,
          avgDuration: 5000,
          activeUsers: 10,
          activeChats: 8,
          totalTokenUsage: 2500,
          fallbackCount: 2,
          fallbackSuccessCount: 1,
        }),
      );
    });

    it('should include ISO hour key in saved stats', async () => {
      const mockAggregated = {
        messageCount: 10,
        successCount: 9,
        failureCount: 1,
        successRate: 90,
        avgDuration: 3000,
        minDuration: 1000,
        maxDuration: 10000,
        p50Duration: 2500,
        p95Duration: 8000,
        p99Duration: 9500,
        avgAiDuration: 2000,
        avgSendDuration: 800,
        activeUsers: 5,
        activeChats: 4,
        totalTokenUsage: 1000,
        fallbackCount: 0,
        fallbackSuccessCount: 0,
        scenarioStats: {},
        toolStats: {},
      };
      mockMonitoringRecordRepository.aggregateHourlyStats.mockResolvedValue(mockAggregated);

      await service.aggregateHourlyStats();

      expect(hourlyStatsRepository.saveHourlyStats).toHaveBeenCalledWith(
        expect.objectContaining({
          hour: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
        }),
      );
    });

    it('should skip saving when aggregated data has zero messages', async () => {
      mockMonitoringRecordRepository.aggregateHourlyStats.mockResolvedValue({
        messageCount: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        avgDuration: 0,
        minDuration: 0,
        maxDuration: 0,
        p50Duration: 0,
        p95Duration: 0,
        p99Duration: 0,
        avgAiDuration: 0,
        avgSendDuration: 0,
        activeUsers: 0,
        activeChats: 0,
        totalTokenUsage: 0,
        fallbackCount: 0,
        fallbackSuccessCount: 0,
        scenarioStats: {},
        toolStats: {},
      });

      await service.aggregateHourlyStats();

      expect(hourlyStatsRepository.saveHourlyStats).not.toHaveBeenCalled();
    });

    it('should skip saving when aggregated data is null', async () => {
      mockMonitoringRecordRepository.aggregateHourlyStats.mockResolvedValue(null);

      await service.aggregateHourlyStats();

      expect(hourlyStatsRepository.saveHourlyStats).not.toHaveBeenCalled();
    });

    it('should not throw when aggregation fails', async () => {
      mockMonitoringRecordRepository.aggregateHourlyStats.mockRejectedValue(new Error('DB error'));

      await expect(service.aggregateHourlyStats()).resolves.not.toThrow();
    });

    it('should aggregate the correct time range (last full hour)', async () => {
      const mockAggregated = {
        messageCount: 20,
        successCount: 18,
        failureCount: 2,
        successRate: 90,
        avgDuration: 4000,
        minDuration: 500,
        maxDuration: 20000,
        p50Duration: 3500,
        p95Duration: 15000,
        p99Duration: 19000,
        avgAiDuration: 2500,
        avgSendDuration: 1000,
        activeUsers: 8,
        activeChats: 6,
        totalTokenUsage: 1500,
        fallbackCount: 1,
        fallbackSuccessCount: 1,
        scenarioStats: {},
        toolStats: {},
      };
      mockMonitoringRecordRepository.aggregateHourlyStats.mockResolvedValue(mockAggregated);

      await service.aggregateHourlyStats();

      const [startArg, endArg] = (monitoringRepository.aggregateHourlyStats as jest.Mock).mock
        .calls[0];

      // End time should have minutes, seconds, and ms zeroed out (start of current hour)
      expect(endArg.getMinutes()).toBe(0);
      expect(endArg.getSeconds()).toBe(0);
      expect(endArg.getMilliseconds()).toBe(0);

      // Start time should be exactly 1 hour before end
      expect(startArg.getTime()).toBe(endArg.getTime() - 60 * 60 * 1000);
    });
  });
});

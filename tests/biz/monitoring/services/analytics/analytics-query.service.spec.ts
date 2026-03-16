import { Test, TestingModule } from '@nestjs/testing';
import { ScenarioType } from '@agent';
import { AnalyticsQueryService } from '@biz/monitoring/services/analytics/analytics-query.service';
import { MonitoringCacheService } from '@biz/monitoring/services/tracking/monitoring-cache.service';
import { MessageProcessingRepository } from '@biz/message/repositories/message-processing.repository';
import { MonitoringHourlyStatsRepository } from '@biz/monitoring/repositories/monitoring-hourly-stats.repository';
import { MonitoringErrorLogRepository } from '@biz/monitoring/repositories/monitoring-error-log.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';

const buildRecord = (overrides = {}) => ({
  messageId: 'msg-1',
  chatId: 'chat-1',
  userId: 'user-1',
  userName: 'User One',
  status: 'success' as const,
  receivedAt: Date.now(),
  totalDuration: 5000,
  queueDuration: 500,
  scenario: ScenarioType.CANDIDATE_CONSULTATION,
  tools: [],
  ...overrides,
});

const buildErrorLog = (overrides = {}) => ({
  messageId: 'msg-err-1',
  timestamp: Date.now(),
  error: 'Some error',
  alertType: 'agent' as const,
  ...overrides,
});

describe('AnalyticsQueryService', () => {
  let service: AnalyticsQueryService;
  let messageProcessingRepository: jest.Mocked<MessageProcessingRepository>;
  let hourlyStatsRepository: jest.Mocked<MonitoringHourlyStatsRepository>;
  let _errorLogRepository: jest.Mocked<MonitoringErrorLogRepository>;
  let _userHostingService: jest.Mocked<UserHostingService>;
  let _cacheService: jest.Mocked<MonitoringCacheService>;
  let _messageTrackingService: jest.Mocked<MessageTrackingService>;

  const mockMessageProcessingRepository = {
    getRecordsByTimeRange: jest.fn(),
    getMessageProcessingRecords: jest.fn(),
    getMessageStats: jest.fn(),
    getActiveUsers: jest.fn(),
    getDailyUserStats: jest.fn(),
  };

  const mockHourlyStatsRepository = {
    getRecentHourlyStats: jest.fn(),
  };

  const mockErrorLogRepository = {
    getErrorLogsSince: jest.fn(),
    getRecentErrors: jest.fn(),
  };

  const mockUserHostingService = {
    getUserHostingStatus: jest.fn(),
  };

  const mockCacheService = {
    getCounters: jest.fn(),
  };

  const mockMessageTrackingService = {
    getPendingCount: jest.fn().mockReturnValue(0),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsQueryService,
        {
          provide: MessageProcessingRepository,
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
          provide: UserHostingService,
          useValue: mockUserHostingService,
        },
        {
          provide: MonitoringCacheService,
          useValue: mockCacheService,
        },
        {
          provide: MessageTrackingService,
          useValue: mockMessageTrackingService,
        },
      ],
    }).compile();

    service = module.get<AnalyticsQueryService>(AnalyticsQueryService);
    messageProcessingRepository = module.get(MessageProcessingRepository);
    hourlyStatsRepository = module.get(MonitoringHourlyStatsRepository);
    _errorLogRepository = module.get(MonitoringErrorLogRepository);
    _userHostingService = module.get(UserHostingService);
    _cacheService = module.get(MonitoringCacheService);
    _messageTrackingService = module.get(MessageTrackingService);

    jest.clearAllMocks();

    // Setup defaults
    mockMessageProcessingRepository.getRecordsByTimeRange.mockResolvedValue([]);
    mockMessageProcessingRepository.getMessageProcessingRecords.mockResolvedValue({
      records: [],
      total: 0,
    });
    mockMessageProcessingRepository.getActiveUsers.mockResolvedValue([]);
    mockMessageProcessingRepository.getDailyUserStats.mockResolvedValue([]);
    mockHourlyStatsRepository.getRecentHourlyStats.mockResolvedValue([]);
    mockErrorLogRepository.getErrorLogsSince.mockResolvedValue([]);
    mockErrorLogRepository.getRecentErrors.mockResolvedValue([]);
    mockCacheService.getCounters.mockResolvedValue({
      totalMessages: 0,
      totalSuccess: 0,
      totalFailure: 0,
      totalAiDuration: 0,
      totalSendDuration: 0,
      totalFallback: 0,
      totalFallbackSuccess: 0,
    });
    mockUserHostingService.getUserHostingStatus.mockResolvedValue({ isPaused: false });
    mockMessageTrackingService.getPendingCount.mockReturnValue(0);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========================================
  // getSystemMonitoringAsync
  // ========================================

  describe('getSystemMonitoringAsync', () => {
    it('should return queue metrics, alerts summary, and alert trend', async () => {
      const now = Date.now();
      const records = [buildRecord({ queueDuration: 500 }), buildRecord({ queueDuration: 1000 })];
      const errorLogs = [
        buildErrorLog({ timestamp: now - 1000 }),
        buildErrorLog({ timestamp: now - 2000 }),
      ];

      mockMessageProcessingRepository.getRecordsByTimeRange.mockResolvedValue(records);
      mockErrorLogRepository.getErrorLogsSince.mockResolvedValue(errorLogs);

      const result = await service.getSystemMonitoringAsync();

      expect(result).toHaveProperty('queue');
      expect(result).toHaveProperty('alertsSummary');
      expect(result).toHaveProperty('alertTrend');
      expect(result.queue.currentProcessing).toBe(0);
      expect(result.alertsSummary.total).toBe(2);
    });

    it('should return empty data gracefully when records fetch fails', async () => {
      // getRecordsByTimeRange private method swallows errors and returns []
      // so getSystemMonitoringAsync resolves with empty/default values
      mockMessageProcessingRepository.getRecordsByTimeRange.mockRejectedValue(
        new Error('DB error'),
      );

      const result = await service.getSystemMonitoringAsync();

      expect(result).toHaveProperty('queue');
      expect(result.queue.avgQueueDuration).toBe(0);
      expect(result.alertsSummary.total).toBeGreaterThanOrEqual(0);
    });

    it('should return queue with avgQueueDuration calculated from records', async () => {
      const records = [buildRecord({ queueDuration: 400 }), buildRecord({ queueDuration: 600 })];
      mockMessageProcessingRepository.getRecordsByTimeRange.mockResolvedValue(records);

      const result = await service.getSystemMonitoringAsync();

      expect(result.queue.avgQueueDuration).toBe(500);
    });

    it('should calculate alertsSummary correctly with timestamps', async () => {
      const now = Date.now();
      const errorLogs = [
        buildErrorLog({ timestamp: now - 30 * 60 * 1000 }), // 30 min ago (last hour)
        buildErrorLog({ timestamp: now - 2 * 60 * 60 * 1000 }), // 2h ago (last 24h but not last hour)
        buildErrorLog({ timestamp: now - 25 * 60 * 60 * 1000 }), // 25h ago (not in last 24h)
      ];
      mockErrorLogRepository.getErrorLogsSince.mockResolvedValue(errorLogs);

      const result = await service.getSystemMonitoringAsync();

      expect(result.alertsSummary.total).toBe(3);
      expect(result.alertsSummary.lastHour).toBe(1);
      expect(result.alertsSummary.last24Hours).toBe(2);
    });
  });

  // ========================================
  // getTrendsDataAsync
  // ========================================

  describe('getTrendsDataAsync', () => {
    it('should return daily trend, response trend, alert trend, and business trend', async () => {
      mockMessageProcessingRepository.getRecordsByTimeRange.mockResolvedValue([]);
      mockErrorLogRepository.getErrorLogsSince.mockResolvedValue([]);
      mockHourlyStatsRepository.getRecentHourlyStats.mockResolvedValue([]);

      const result = await service.getTrendsDataAsync('today');

      expect(result).toHaveProperty('dailyTrend');
      expect(result).toHaveProperty('responseTrend');
      expect(result).toHaveProperty('alertTrend');
      expect(result).toHaveProperty('businessTrend');
    });

    it('should return empty data gracefully when records fetch fails', async () => {
      // getRecordsByTimeRange private method swallows errors and returns []
      // so getTrendsDataAsync resolves with empty trend arrays
      mockMessageProcessingRepository.getRecordsByTimeRange.mockRejectedValue(
        new Error('DB error'),
      );

      const result = await service.getTrendsDataAsync('today');

      expect(result).toHaveProperty('dailyTrend');
      expect(result).toHaveProperty('responseTrend');
      expect(result.responseTrend).toEqual([]);
      expect(result.businessTrend).toEqual([]);
    });

    it('should use 24 hourly stats for today range', async () => {
      await service.getTrendsDataAsync('today');

      expect(hourlyStatsRepository.getRecentHourlyStats).toHaveBeenCalledWith(24);
    });

    it('should use 168 hourly stats for week range', async () => {
      await service.getTrendsDataAsync('week');

      expect(hourlyStatsRepository.getRecentHourlyStats).toHaveBeenCalledWith(168);
    });

    it('should use 720 hourly stats for month range', async () => {
      await service.getTrendsDataAsync('month');

      expect(hourlyStatsRepository.getRecentHourlyStats).toHaveBeenCalledWith(720);
    });
  });

  // ========================================
  // getMetricsDataAsync
  // ========================================

  describe('getMetricsDataAsync', () => {
    it('should return metrics data with percentiles and slowest records', async () => {
      const records = [
        buildRecord({ totalDuration: 1000 }),
        buildRecord({ totalDuration: 5000 }),
        buildRecord({ totalDuration: 10000 }),
      ];
      mockMessageProcessingRepository.getMessageProcessingRecords.mockResolvedValue({
        records,
        total: records.length,
      });

      const result = await service.getMetricsDataAsync();

      expect(result).toHaveProperty('detailRecords');
      expect(result).toHaveProperty('hourlyStats');
      expect(result).toHaveProperty('globalCounters');
      expect(result).toHaveProperty('percentiles');
      expect(result).toHaveProperty('slowestRecords');
      expect(result).toHaveProperty('recentAlertCount');
      expect(result.percentiles.p50).toBeGreaterThan(0);
    });

    it('should filter out records exceeding MAX_DURATION_MS (60s) for percentile calc', async () => {
      const records = [
        buildRecord({ totalDuration: 5000 }),
        buildRecord({ totalDuration: 70000 }), // exceeds 60s, excluded from percentiles
      ];
      mockMessageProcessingRepository.getMessageProcessingRecords.mockResolvedValue({
        records,
        total: records.length,
      });

      const result = await service.getMetricsDataAsync();

      // p50 should only consider the 5000ms record
      expect(result.percentiles.p50).toBe(5000);
    });

    it('should limit slowestRecords to top 10', async () => {
      const records = Array.from({ length: 15 }, (_, i) =>
        buildRecord({ messageId: `msg-${i}`, totalDuration: (i + 1) * 1000 }),
      );
      mockMessageProcessingRepository.getMessageProcessingRecords.mockResolvedValue({
        records,
        total: records.length,
      });

      const result = await service.getMetricsDataAsync();

      expect(result.slowestRecords).toHaveLength(10);
    });

    it('should sort slowestRecords by totalDuration descending', async () => {
      const records = [
        buildRecord({ messageId: 'msg-1', totalDuration: 1000 }),
        buildRecord({ messageId: 'msg-2', totalDuration: 5000 }),
        buildRecord({ messageId: 'msg-3', totalDuration: 3000 }),
      ];
      mockMessageProcessingRepository.getMessageProcessingRecords.mockResolvedValue({
        records,
        total: records.length,
      });

      const result = await service.getMetricsDataAsync();

      expect(result.slowestRecords[0].messageId).toBe('msg-2');
      expect(result.slowestRecords[1].messageId).toBe('msg-3');
    });

    it('should return empty metrics on error', async () => {
      mockMessageProcessingRepository.getMessageProcessingRecords.mockRejectedValue(
        new Error('DB error'),
      );

      const result = await service.getMetricsDataAsync();

      expect(result.detailRecords).toEqual([]);
      expect(result.percentiles).toEqual({ p50: 0, p95: 0, p99: 0, p999: 0 });
      expect(result.recentAlertCount).toBe(0);
    });
  });

  // ========================================
  // getMessageStatsAsync
  // ========================================

  describe('getMessageStatsAsync', () => {
    it('should delegate to messageProcessingRepository.getMessageStats', async () => {
      const expected = { total: 100, success: 90, failed: 10, avgDuration: 5000 };
      mockMessageProcessingRepository.getMessageStats = jest.fn().mockResolvedValue(expected);

      const result = await service.getMessageStatsAsync(1000, 2000);

      expect(result).toEqual(expected);
      expect(messageProcessingRepository.getMessageStats).toHaveBeenCalledWith(1000, 2000);
    });
  });

  // ========================================
  // getTodayUsers
  // ========================================

  describe('getTodayUsers', () => {
    it('should return users from database on first call', async () => {
      mockMessageProcessingRepository.getActiveUsers.mockResolvedValue([
        {
          chatId: 'chat-1',
          userId: 'user-1',
          userName: 'User One',
          messageCount: 3,
          tokenUsage: 150,
          firstActiveAt: Date.now(),
          lastActiveAt: Date.now(),
        },
      ]);
      mockUserHostingService.getUserHostingStatus.mockResolvedValue({ isPaused: false });

      const result = await service.getTodayUsers();

      expect(result).toHaveLength(1);
      expect(result[0].chatId).toBe('chat-1');
      expect(result[0].isPaused).toBe(false);
    });

    it('should return in-memory cached users on second call', async () => {
      mockMessageProcessingRepository.getActiveUsers.mockResolvedValue([
        {
          chatId: 'chat-1',
          userId: 'user-1',
          userName: 'User One',
          messageCount: 3,
          tokenUsage: 150,
          firstActiveAt: Date.now(),
          lastActiveAt: Date.now(),
        },
      ]);
      mockUserHostingService.getUserHostingStatus.mockResolvedValue({ isPaused: false });

      await service.getTodayUsers();
      await service.getTodayUsers();

      expect(messageProcessingRepository.getActiveUsers).toHaveBeenCalledTimes(1);
    });

    it('should not cache empty user list', async () => {
      mockMessageProcessingRepository.getActiveUsers.mockResolvedValue([]);

      await service.getTodayUsers();
      await service.getTodayUsers();

      expect(messageProcessingRepository.getActiveUsers).toHaveBeenCalledTimes(2);
    });
  });

  // ========================================
  // getTodayUsersFromDatabase
  // ========================================

  describe('getTodayUsersFromDatabase', () => {
    it('should map database users to TodayUser format', async () => {
      mockMessageProcessingRepository.getActiveUsers.mockResolvedValue([
        {
          chatId: 'chat-1',
          userId: 'user-1',
          userName: 'User One',
          messageCount: 5,
          tokenUsage: 200,
          firstActiveAt: 1000,
          lastActiveAt: 2000,
        },
      ]);
      mockUserHostingService.getUserHostingStatus.mockResolvedValue({ isPaused: true });

      const result = await service.getTodayUsersFromDatabase();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        chatId: 'chat-1',
        odId: 'user-1',
        odName: 'User One',
        messageCount: 5,
        tokenUsage: 200,
        isPaused: true,
      });
    });

    it('should fallback to chatId for missing userId and userName', async () => {
      mockMessageProcessingRepository.getActiveUsers.mockResolvedValue([
        {
          chatId: 'chat-1',
          userId: null,
          userName: null,
          messageCount: 1,
          tokenUsage: 0,
          firstActiveAt: 1000,
          lastActiveAt: 2000,
        },
      ]);
      mockUserHostingService.getUserHostingStatus.mockResolvedValue({ isPaused: false });

      const result = await service.getTodayUsersFromDatabase();

      expect(result[0].odId).toBe('chat-1');
      expect(result[0].odName).toBe('chat-1');
    });
  });

  // ========================================
  // getSystemInfo
  // ========================================

  describe('getSystemInfo', () => {
    it('should return system info including status, memory, cpu, and platform', async () => {
      const result = await service.getSystemInfo();

      expect(result.status).toBe('healthy');
      expect(result).toHaveProperty('uptime');
      expect(result).toHaveProperty('memory');
      expect(result.memory).toHaveProperty('used');
      expect(result.memory).toHaveProperty('total');
      expect(result).toHaveProperty('cpu');
      expect(result).toHaveProperty('platform');
      expect(result).toHaveProperty('nodeVersion');
    });
  });

  // ========================================
  // getUsersByDate
  // ========================================

  describe('getUsersByDate', () => {
    it('should return users for a valid date string', async () => {
      mockMessageProcessingRepository.getActiveUsers.mockResolvedValue([
        {
          chatId: 'chat-1',
          userId: 'user-1',
          userName: 'User One',
          messageCount: 3,
          tokenUsage: 100,
          firstActiveAt: 1000,
          lastActiveAt: 2000,
        },
      ]);
      mockUserHostingService.getUserHostingStatus.mockResolvedValue({ isPaused: false });

      const result = await service.getUsersByDate('2026-03-11');

      expect(result).toHaveLength(1);
      expect(result[0].chatId).toBe('chat-1');
    });

    it('should return empty array for invalid date format', async () => {
      const result = await service.getUsersByDate('invalid-date');

      expect(result).toEqual([]);
      expect(messageProcessingRepository.getActiveUsers).not.toHaveBeenCalled();
    });

    it('should query the correct date range for given date', async () => {
      mockMessageProcessingRepository.getActiveUsers.mockResolvedValue([]);

      await service.getUsersByDate('2026-03-11');

      const [startDate, endDate] = (messageProcessingRepository.getActiveUsers as jest.Mock).mock
        .calls[0];

      expect(startDate.getHours()).toBe(0);
      expect(startDate.getMinutes()).toBe(0);
      expect(endDate.getHours()).toBe(23);
      expect(endDate.getMinutes()).toBe(59);
    });
  });

  // ========================================
  // getUserTrend
  // ========================================

  describe('getUserTrend', () => {
    it('should return 30-day user trend data', async () => {
      mockMessageProcessingRepository.getDailyUserStats.mockResolvedValue([
        { date: '2026-03-11', uniqueUsers: 10, messageCount: 50 },
        { date: '2026-03-10', uniqueUsers: 8, messageCount: 40 },
      ]);

      const result = await service.getUserTrend();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ date: '2026-03-11', userCount: 10, messageCount: 50 });
      expect(result[1]).toEqual({ date: '2026-03-10', userCount: 8, messageCount: 40 });
    });

    it('should query last 30 days', async () => {
      mockMessageProcessingRepository.getDailyUserStats.mockResolvedValue([]);

      await service.getUserTrend();

      const [startDate, endDate] = (messageProcessingRepository.getDailyUserStats as jest.Mock).mock
        .calls[0];

      const daysDiff = Math.round(
        (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000),
      );
      expect(daysDiff).toBe(30);
    });
  });

  // ========================================
  // getRecentDetailRecords
  // ========================================

  describe('getRecentDetailRecords', () => {
    it('should return recent detail records with default limit', async () => {
      const records = [buildRecord(), buildRecord({ messageId: 'msg-2' })];
      mockMessageProcessingRepository.getMessageProcessingRecords.mockResolvedValue({
        records,
        total: records.length,
      });

      const result = await service.getRecentDetailRecords();

      expect(result).toHaveLength(2);
      expect(messageProcessingRepository.getMessageProcessingRecords).toHaveBeenCalledWith({
        limit: 50,
      });
    });

    it('should respect custom limit parameter', async () => {
      mockMessageProcessingRepository.getMessageProcessingRecords.mockResolvedValue({
        records: [],
        total: 0,
      });

      await service.getRecentDetailRecords(20);

      expect(messageProcessingRepository.getMessageProcessingRecords).toHaveBeenCalledWith({
        limit: 20,
      });
    });

    it('should return empty array on error', async () => {
      mockMessageProcessingRepository.getMessageProcessingRecords.mockRejectedValue(
        new Error('DB error'),
      );

      const result = await service.getRecentDetailRecords();

      expect(result).toEqual([]);
    });
  });
});

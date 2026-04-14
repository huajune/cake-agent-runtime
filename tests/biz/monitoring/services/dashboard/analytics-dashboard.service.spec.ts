import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsMetricsService } from '@analytics/metrics/analytics-metrics.service';
import { AnalyticsTrendBuilderService } from '@analytics/trends/analytics-trend-builder.service';
import { ScenarioType } from '@enums/agent.enum';
import { AnalyticsDashboardService } from '@biz/monitoring/services/dashboard/analytics-dashboard.service';
import { MonitoringCacheService } from '@biz/monitoring/services/tracking/monitoring-cache.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { BookingService } from '@biz/message/services/booking.service';
import { MonitoringHourlyStatsRepository } from '@biz/monitoring/repositories/hourly-stats.repository';
import { MonitoringErrorLogRepository } from '@biz/monitoring/repositories/error-log.repository';
import { MonitoringRecordRepository } from '@biz/monitoring/repositories/record.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { HourlyStatsAggregatorService } from '@biz/monitoring/services/projections/hourly-stats-aggregator.service';
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
  tools: ['tool-a'],
  isFallback: false,
  ...overrides,
});

const defaultOverview = {
  totalMessages: 0,
  successCount: 0,
  failureCount: 0,
  successRate: 0,
  avgDuration: 0,
  activeUsers: 0,
  activeChats: 0,
  totalTokenUsage: 0,
};

const defaultFallback = {
  totalCount: 0,
  successCount: 0,
  successRate: 0,
  affectedUsers: 0,
};

const buildHourlyStatsRow = (overrides = {}) => ({
  hour: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
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
  ...overrides,
});

describe('AnalyticsDashboardService', () => {
  let service: AnalyticsDashboardService;
  let _messageProcessingService: jest.Mocked<MessageProcessingService>;
  let _hourlyStatsRepository: jest.Mocked<MonitoringHourlyStatsRepository>;
  let _errorLogRepository: jest.Mocked<MonitoringErrorLogRepository>;
  let _userHostingService: jest.Mocked<UserHostingService>;
  let _cacheService: jest.Mocked<MonitoringCacheService>;
  let monitoringRepository: jest.Mocked<MonitoringRecordRepository>;
  let _bookingService: jest.Mocked<BookingService>;
  let hourlyStatsAggregator: jest.Mocked<HourlyStatsAggregatorService>;
  let _messageTrackingService: jest.Mocked<MessageTrackingService>;

  const mockMessageProcessingService = {
    getRecordsByTimeRange: jest.fn(),
    getRecordsByTimestamps: jest.fn(),
    getActiveUsers: jest.fn(),
  };

  const mockHourlyStatsRepository = {
    getRecentHourlyStats: jest.fn(),
  };

  const mockErrorLogRepository = {
    getErrorLogsSince: jest.fn(),
  };

  const mockUserHostingService = {
    getUserHostingStatus: jest.fn(),
  };

  const mockCacheService = {
    getCounters: jest.fn(),
  };

  const mockMonitoringRecordRepository = {
    getDashboardOverviewStats: jest.fn(),
    getDashboardFallbackStats: jest.fn(),
    getDashboardDailyTrend: jest.fn(),
    getDashboardMinuteTrend: jest.fn(),
    getDashboardHourlyTrend: jest.fn(),
  };

  const mockBookingService = {
    getBookingStats: jest.fn(),
  };

  const mockHourlyStatsAggregator = {
    getOverviewFromHourly: jest.fn(),
    getFallbackFromHourly: jest.fn(),
    getDailyTrendFromHourly: jest.fn(),
    getHourlyTrendFromHourly: jest.fn(),
    mergeOverviewStats: jest.fn(),
    mergeFallbackStats: jest.fn(),
  };

  const mockMessageTrackingService = {
    getPendingCount: jest.fn().mockReturnValue(0),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyticsDashboardService,
        {
          provide: MessageProcessingService,
          useValue: mockMessageProcessingService,
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
          provide: MonitoringRecordRepository,
          useValue: mockMonitoringRecordRepository,
        },
        {
          provide: BookingService,
          useValue: mockBookingService,
        },
        {
          provide: HourlyStatsAggregatorService,
          useValue: mockHourlyStatsAggregator,
        },
        {
          provide: MessageTrackingService,
          useValue: mockMessageTrackingService,
        },
        AnalyticsMetricsService,
        AnalyticsTrendBuilderService,
      ],
    }).compile();

    service = module.get<AnalyticsDashboardService>(AnalyticsDashboardService);
    _messageProcessingService = module.get(MessageProcessingService);
    _hourlyStatsRepository = module.get(MonitoringHourlyStatsRepository);
    _errorLogRepository = module.get(MonitoringErrorLogRepository);
    _userHostingService = module.get(UserHostingService);
    _cacheService = module.get(MonitoringCacheService);
    monitoringRepository = module.get(MonitoringRecordRepository);
    _bookingService = module.get(BookingService);
    hourlyStatsAggregator = module.get(HourlyStatsAggregatorService);
    _messageTrackingService = module.get(MessageTrackingService);

    jest.clearAllMocks();

    // Setup defaults
    mockMessageProcessingService.getRecordsByTimeRange.mockResolvedValue([]);
    mockMessageProcessingService.getRecordsByTimestamps.mockResolvedValue({
      records: [],
      total: 0,
    });
    mockMessageProcessingService.getActiveUsers.mockResolvedValue([]);
    mockHourlyStatsRepository.getRecentHourlyStats.mockResolvedValue([buildHourlyStatsRow()]);
    mockErrorLogRepository.getErrorLogsSince.mockResolvedValue([]);
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
    mockBookingService.getBookingStats.mockResolvedValue([]);
    mockHourlyStatsAggregator.getOverviewFromHourly.mockResolvedValue(defaultOverview);
    mockHourlyStatsAggregator.getFallbackFromHourly.mockResolvedValue(defaultFallback);
    mockHourlyStatsAggregator.getDailyTrendFromHourly.mockResolvedValue([]);
    mockHourlyStatsAggregator.getHourlyTrendFromHourly.mockResolvedValue([]);
    mockHourlyStatsAggregator.mergeOverviewStats.mockReturnValue(defaultOverview);
    mockHourlyStatsAggregator.mergeFallbackStats.mockReturnValue(defaultFallback);
    mockMonitoringRecordRepository.getDashboardOverviewStats.mockResolvedValue(defaultOverview);
    mockMonitoringRecordRepository.getDashboardFallbackStats.mockResolvedValue(defaultFallback);
    mockMonitoringRecordRepository.getDashboardDailyTrend.mockResolvedValue([]);
    mockMonitoringRecordRepository.getDashboardMinuteTrend.mockResolvedValue([]);
    mockMonitoringRecordRepository.getDashboardHourlyTrend.mockResolvedValue([]);
    mockMessageTrackingService.getPendingCount.mockReturnValue(0);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========================================
  // getDashboardDataAsync
  // ========================================

  describe('getDashboardDataAsync', () => {
    it('should return complete dashboard data structure', async () => {
      const result = await service.getDashboardDataAsync('today');

      expect(result).toHaveProperty('timeRange', 'today');
      expect(result).toHaveProperty('overview');
      expect(result).toHaveProperty('overviewDelta');
      expect(result).toHaveProperty('fallback');
      expect(result).toHaveProperty('fallbackDelta');
      expect(result).toHaveProperty('business');
      expect(result).toHaveProperty('businessDelta');
      expect(result).toHaveProperty('usage');
      expect(result).toHaveProperty('queue');
      expect(result).toHaveProperty('alertsSummary');
      expect(result).toHaveProperty('trends');
      expect(result).toHaveProperty('responseTrend');
      expect(result).toHaveProperty('alertTrend');
      expect(result).toHaveProperty('businessTrend');
      expect(result).toHaveProperty('todayUsers');
      expect(result).toHaveProperty('recentMessages');
      expect(result).toHaveProperty('recentErrors');
      expect(result).toHaveProperty('realtime');
    });

    it('should include processingCount from messageTrackingService in realtime', async () => {
      mockMessageTrackingService.getPendingCount.mockReturnValue(5);

      const result = await service.getDashboardDataAsync('today');

      expect(result.realtime.processingCount).toBe(5);
    });

    it('should calculate overview from current records', async () => {
      const records = [
        buildRecord({ status: 'success', totalDuration: 4000 }),
        buildRecord({
          messageId: 'msg-2',
          chatId: 'chat-2',
          status: 'success',
          totalDuration: 6000,
        }),
        buildRecord({
          messageId: 'msg-3',
          chatId: 'chat-3',
          status: 'failure',
          totalDuration: 2000,
        }),
      ];
      mockMessageProcessingService.getRecordsByTimeRange.mockResolvedValue(records);

      const result = await service.getDashboardDataAsync('today');

      expect(result.overview.totalMessages).toBe(3);
      expect(result.overview.successCount).toBe(2);
      expect(result.overview.failureCount).toBe(1);
      expect(result.overview.successRate).toBeCloseTo(66.67, 1);
      expect(result.overview.avgDuration).toBeCloseTo(4000, 0);
      expect(result.overview.activeChats).toBe(3);
    });

    it('should calculate fallback stats correctly', async () => {
      const records = [
        buildRecord({ isFallback: true, fallbackSuccess: true, userId: 'user-1' }),
        buildRecord({
          messageId: 'msg-2',
          isFallback: true,
          fallbackSuccess: false,
          userId: 'user-2',
        }),
        buildRecord({ messageId: 'msg-3', isFallback: false }),
      ];
      mockMessageProcessingService.getRecordsByTimeRange.mockResolvedValue(records);

      const result = await service.getDashboardDataAsync('today');

      expect(result.fallback.totalCount).toBe(2);
      expect(result.fallback.successCount).toBe(1);
      expect(result.fallback.successRate).toBe(50);
      expect(result.fallback.affectedUsers).toBe(2);
    });

    it('should build tool usage metrics from records', async () => {
      const records = [
        buildRecord({ tools: ['booking', 'search'] }),
        buildRecord({ messageId: 'msg-2', tools: ['booking'] }),
        buildRecord({ messageId: 'msg-3', tools: [] }),
      ];
      mockMessageProcessingService.getRecordsByTimeRange.mockResolvedValue(records);

      const result = await service.getDashboardDataAsync('today');

      expect(result.usage.tools).toHaveLength(2);
      expect(result.usage.tools[0].name).toBe('booking');
      expect(result.usage.tools[0].total).toBe(2);
    });

    it('should build scenario usage metrics from records', async () => {
      const records = [
        buildRecord({ scenario: ScenarioType.CANDIDATE_CONSULTATION }),
        buildRecord({ messageId: 'msg-2', scenario: ScenarioType.CANDIDATE_CONSULTATION }),
        buildRecord({ messageId: 'msg-3', scenario: undefined }),
      ];
      mockMessageProcessingService.getRecordsByTimeRange.mockResolvedValue(records);

      const result = await service.getDashboardDataAsync('today');

      const consulting = result.usage.scenarios.find(
        (s) => s.name === ScenarioType.CANDIDATE_CONSULTATION,
      );
      expect(consulting!.total).toBe(2);
    });

    it('should fetch todayUsers only for today range', async () => {
      mockMessageProcessingService.getActiveUsers.mockResolvedValue([
        {
          chatId: 'chat-1',
          userId: 'user-1',
          userName: 'User One',
          messageCount: 3,
          tokenUsage: 100,
          firstActiveAt: Date.now(),
          lastActiveAt: Date.now(),
        },
      ]);

      const resultToday = await service.getDashboardDataAsync('today');
      expect(resultToday.todayUsers).toHaveLength(1);

      jest.clearAllMocks();
      mockMessageProcessingService.getRecordsByTimeRange.mockResolvedValue([]);
      mockMessageProcessingService.getRecordsByTimestamps.mockResolvedValue({
        records: [],
        total: 0,
      });
      mockErrorLogRepository.getErrorLogsSince.mockResolvedValue([]);
      mockCacheService.getCounters.mockResolvedValue({
        totalMessages: 0,
        totalSuccess: 0,
        totalFailure: 0,
        totalAiDuration: 0,
        totalSendDuration: 0,
        totalFallback: 0,
        totalFallbackSuccess: 0,
      });
      mockHourlyStatsRepository.getRecentHourlyStats.mockResolvedValue([]);
      mockBookingService.getBookingStats.mockResolvedValue([]);

      const resultWeek = await service.getDashboardDataAsync('week');
      expect(resultWeek.todayUsers).toHaveLength(0);
    });

    it('should return empty dashboard data on error', async () => {
      mockMessageProcessingService.getRecordsByTimeRange.mockRejectedValue(
        new Error('DB error'),
      );

      const result = await service.getDashboardDataAsync('today');

      expect(result.overview.totalMessages).toBe(0);
      expect(result.overview.successRate).toBe(0);
      expect(result.usage.tools).toEqual([]);
      expect(result.todayUsers).toEqual([]);
    });

    it('should calculate overviewDelta as percent change from previous period', async () => {
      // Current period: 100 messages
      // Previous period: 50 messages
      // Delta = 100%
      mockMessageProcessingService.getRecordsByTimeRange
        .mockResolvedValueOnce(
          Array.from({ length: 100 }, (_, i) => buildRecord({ messageId: `msg-${i}` })),
        )
        .mockResolvedValueOnce(
          Array.from({ length: 50 }, (_, i) => buildRecord({ messageId: `prev-${i}` })),
        );

      const result = await service.getDashboardDataAsync('week');

      expect(result.overviewDelta.totalMessages).toBe(100);
    });
  });

  // ========================================
  // getDashboardOverviewAsync
  // ========================================

  describe('getDashboardOverviewAsync', () => {
    it('should return overview data structure for today range', async () => {
      mockHourlyStatsAggregator.mergeOverviewStats.mockReturnValue({
        ...defaultOverview,
        totalMessages: 100,
        successCount: 90,
        successRate: 90,
        avgDuration: 5000,
        activeUsers: 20,
        activeChats: 15,
      });

      const result = await service.getDashboardOverviewAsync('today');

      expect(result).toHaveProperty('timeRange', 'today');
      expect(result).toHaveProperty('overview');
      expect(result).toHaveProperty('overviewDelta');
      expect(result).toHaveProperty('dailyTrend');
      expect(result).toHaveProperty('tokenTrend');
      expect(result).toHaveProperty('businessTrend');
      expect(result).toHaveProperty('responseTrend');
      expect(result).toHaveProperty('business');
      expect(result).toHaveProperty('businessDelta');
      expect(result).toHaveProperty('fallback');
      expect(result).toHaveProperty('fallbackDelta');
    });

    it('should merge historical and realtime overview for today range', async () => {
      const historicalOverview = { ...defaultOverview, totalMessages: 80, successCount: 72 };
      const realtimeOverview = { ...defaultOverview, totalMessages: 20, successCount: 18 };
      const mergedOverview = {
        ...defaultOverview,
        totalMessages: 100,
        successCount: 90,
        successRate: 90,
        avgDuration: 5000,
        activeUsers: 20,
        activeChats: 15,
      };

      mockHourlyStatsAggregator.getOverviewFromHourly.mockResolvedValueOnce(historicalOverview);
      mockMonitoringRecordRepository.getDashboardOverviewStats.mockResolvedValueOnce(realtimeOverview);
      mockHourlyStatsAggregator.mergeOverviewStats.mockReturnValue(mergedOverview);

      const result = await service.getDashboardOverviewAsync('today');

      expect(hourlyStatsAggregator.mergeOverviewStats).toHaveBeenCalledWith(
        historicalOverview,
        realtimeOverview,
      );
      expect(result.overview.totalMessages).toBe(100);
    });

    it('should use hourly stats aggregator for week range (no real-time merge)', async () => {
      mockHourlyStatsAggregator.getOverviewFromHourly.mockResolvedValue({
        ...defaultOverview,
        totalMessages: 500,
        successRate: 88,
      });
      mockHourlyStatsAggregator.getFallbackFromHourly.mockResolvedValue(defaultFallback);

      const result = await service.getDashboardOverviewAsync('week');

      // For week range, should not call monitoringRepository real-time methods
      expect(monitoringRepository.getDashboardOverviewStats).not.toHaveBeenCalled();
      expect(result.overview.totalMessages).toBe(500);
    });

    it('should fall back to raw repository queries when hourly projection is stale for today', async () => {
      mockHourlyStatsRepository.getRecentHourlyStats.mockResolvedValue([
        buildHourlyStatsRow({
          hour: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        }),
      ]);

      mockMonitoringRecordRepository.getDashboardOverviewStats
        .mockResolvedValueOnce({
          ...defaultOverview,
          totalMessages: 12,
          successCount: 10,
          failureCount: 2,
          successRate: 83.33,
          activeUsers: 4,
          activeChats: 3,
        })
        .mockResolvedValueOnce({
          ...defaultOverview,
          totalMessages: 6,
          successCount: 5,
          failureCount: 1,
          successRate: 83.33,
          activeUsers: 2,
          activeChats: 2,
        });

      mockMonitoringRecordRepository.getDashboardFallbackStats
        .mockResolvedValueOnce({
          ...defaultFallback,
          totalCount: 3,
          successCount: 2,
          successRate: 66.67,
          affectedUsers: 2,
        })
        .mockResolvedValueOnce(defaultFallback);

      const result = await service.getDashboardOverviewAsync('today');

      expect(hourlyStatsAggregator.mergeOverviewStats).not.toHaveBeenCalled();
      expect(monitoringRepository.getDashboardOverviewStats).toHaveBeenCalledTimes(2);
      expect(result.overview.totalMessages).toBe(12);
      expect(result.fallback.totalCount).toBe(3);
    });

    it('should fall back to raw repository queries when hourly projection is stale for week', async () => {
      mockHourlyStatsRepository.getRecentHourlyStats.mockResolvedValue([
        buildHourlyStatsRow({
          hour: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        }),
      ]);

      mockMonitoringRecordRepository.getDashboardOverviewStats
        .mockResolvedValueOnce({
          ...defaultOverview,
          totalMessages: 42,
          successCount: 40,
          failureCount: 2,
          successRate: 95.24,
          activeUsers: 8,
          activeChats: 6,
        })
        .mockResolvedValueOnce(defaultOverview);

      mockMonitoringRecordRepository.getDashboardDailyTrend
        .mockResolvedValueOnce([
          {
            date: '2026-04-10',
            messageCount: 10,
            successCount: 9,
            avgDuration: 3000,
            tokenUsage: 1000,
            uniqueUsers: 3,
          },
        ])
        .mockResolvedValueOnce([
          {
            date: '2026-04-13',
            messageCount: 42,
            successCount: 40,
            avgDuration: 3500,
            tokenUsage: 5000,
            uniqueUsers: 8,
          },
        ]);

      const result = await service.getDashboardOverviewAsync('week');

      expect(hourlyStatsAggregator.getOverviewFromHourly).not.toHaveBeenCalled();
      expect(monitoringRepository.getDashboardOverviewStats).toHaveBeenCalledTimes(2);
      expect(result.overview.totalMessages).toBe(42);
      expect(result.responseTrend[0]).toMatchObject({
        minute: '2026-04-13',
        messageCount: 42,
        successRate: 95.24,
      });
    });

    it('should calculate overviewDelta as percent change', async () => {
      const currentOverview = {
        ...defaultOverview,
        totalMessages: 200,
        successRate: 90,
        avgDuration: 5000,
        activeUsers: 20,
      };
      const previousOverview = {
        ...defaultOverview,
        totalMessages: 100,
        successRate: 80,
        avgDuration: 4000,
        activeUsers: 10,
      };

      mockHourlyStatsAggregator.getOverviewFromHourly
        .mockResolvedValueOnce(currentOverview) // historical (today)
        .mockResolvedValueOnce(previousOverview); // previous period

      mockHourlyStatsAggregator.mergeOverviewStats.mockReturnValue(currentOverview);
      mockMonitoringRecordRepository.getDashboardOverviewStats.mockResolvedValue(defaultOverview);

      const result = await service.getDashboardOverviewAsync('today');

      expect(result.overviewDelta.totalMessages).toBe(100); // 100% increase
      expect(result.overviewDelta.successRate).toBe(10); // 90 - 80 = 10 percentage points
    });

    it('should format daily trend from hourly aggregator', async () => {
      mockHourlyStatsAggregator.getDailyTrendFromHourly.mockResolvedValue([
        {
          date: '2026-03-11',
          messageCount: 100,
          successCount: 90,
          avgDuration: 5000,
          tokenUsage: 3000,
          uniqueUsers: 20,
        },
      ]);
      mockHourlyStatsAggregator.mergeOverviewStats.mockReturnValue(defaultOverview);

      const result = await service.getDashboardOverviewAsync('today');

      expect(result.dailyTrend).toHaveLength(1);
      expect(result.dailyTrend[0]).toMatchObject({
        date: '2026-03-11',
        messageCount: 100,
        successCount: 90,
        avgDuration: 5000,
        tokenUsage: 3000,
        uniqueUsers: 20,
      });
    });

    it('should format response trend from minute trend for today', async () => {
      mockMonitoringRecordRepository.getDashboardMinuteTrend.mockResolvedValue([
        { minute: '2026-03-11 10:00', avgDuration: 4000, messageCount: 10, successCount: 9 },
      ]);
      mockHourlyStatsAggregator.mergeOverviewStats.mockReturnValue(defaultOverview);
      mockHourlyStatsAggregator.mergeFallbackStats.mockReturnValue(defaultFallback);

      const result = await service.getDashboardOverviewAsync('today');

      expect(result.responseTrend).toHaveLength(1);
      expect(result.responseTrend[0]).toMatchObject({
        minute: '2026-03-11 10:00',
        avgDuration: 4000,
        messageCount: 10,
        successRate: 90,
      });
    });

    it('should format response trend from daily trend for week range', async () => {
      mockHourlyStatsAggregator.getDailyTrendFromHourly
        .mockResolvedValueOnce([]) // 7-day trend
        .mockResolvedValueOnce([
          { date: '2026-03-11', avgDuration: 5000, messageCount: 50, successCount: 45 },
        ]); // current period

      mockHourlyStatsAggregator.getOverviewFromHourly.mockResolvedValue(defaultOverview);
      mockHourlyStatsAggregator.getFallbackFromHourly.mockResolvedValue(defaultFallback);

      const result = await service.getDashboardOverviewAsync('week');

      expect(result.responseTrend).toHaveLength(1);
      expect(result.responseTrend[0].minute).toBe('2026-03-11');
      expect(result.responseTrend[0].successRate).toBe(90);
    });

    it('should calculate fallbackDelta correctly', async () => {
      const currentFallback = {
        totalCount: 10,
        successCount: 8,
        successRate: 80,
        affectedUsers: 5,
      };
      const previousFallback = {
        totalCount: 5,
        successCount: 4,
        successRate: 80,
        affectedUsers: 3,
      };

      mockHourlyStatsAggregator.getFallbackFromHourly
        .mockResolvedValueOnce(currentFallback) // historical
        .mockResolvedValueOnce(previousFallback); // previous period

      mockHourlyStatsAggregator.mergeFallbackStats.mockReturnValue(currentFallback);
      mockHourlyStatsAggregator.mergeOverviewStats.mockReturnValue(defaultOverview);
      mockMonitoringRecordRepository.getDashboardFallbackStats.mockResolvedValue(defaultFallback);

      const result = await service.getDashboardOverviewAsync('today');

      expect(result.fallbackDelta.totalCount).toBe(100); // 10 vs 5 = 100% increase
      expect(result.fallbackDelta.successRate).toBe(0); // 80 - 80 = 0
    });

    it('should include business metrics from overview stats', async () => {
      mockMessageProcessingService.getRecordsByTimestamps.mockResolvedValue({
        records: [
          buildRecord({ userId: 'user-1' }),
          buildRecord({ messageId: 'msg-2', userId: 'user-2' }),
        ],
        total: 2,
      });
      // business.consultations.total 现在来自 overview 的 activeUsers（SQL 聚合），而非 records
      mockHourlyStatsAggregator.mergeOverviewStats.mockReturnValue({
        ...defaultOverview,
        activeUsers: 2,
      });
      mockHourlyStatsAggregator.mergeFallbackStats.mockReturnValue(defaultFallback);

      const result = await service.getDashboardOverviewAsync('today');

      expect(result.business.consultations.total).toBe(2);
    });

    it('should throw on error without catching', async () => {
      mockHourlyStatsAggregator.getOverviewFromHourly.mockRejectedValue(
        new Error('Aggregator error'),
      );

      await expect(service.getDashboardOverviewAsync('today')).rejects.toThrow('Aggregator error');
    });
  });

  // ========================================
  // buildBusinessTrend (public method)
  // ========================================

  describe('buildBusinessTrend', () => {
    it('should return empty array when no records', () => {
      const result = service.buildBusinessTrend([], 'today');

      expect(result).toEqual([]);
    });

    it('should group records by minute for today range', () => {
      const now = new Date('2026-03-11T10:00:00.000Z').getTime();
      const records = [
        buildRecord({ receivedAt: now, userId: 'user-1' }),
        buildRecord({ messageId: 'msg-2', receivedAt: now + 30 * 1000, userId: 'user-2' }), // same minute
        buildRecord({ messageId: 'msg-3', receivedAt: now + 60 * 1000, userId: 'user-3' }), // next minute
      ];

      const result = service.buildBusinessTrend(records, 'today');

      // First two records are in the same minute bucket
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('should group records by day for week/month range', () => {
      const day1 = new Date('2026-03-11T10:00:00.000Z').getTime();
      const day2 = new Date('2026-03-12T10:00:00.000Z').getTime();
      const records = [
        buildRecord({ receivedAt: day1, userId: 'user-1' }),
        buildRecord({ messageId: 'msg-2', receivedAt: day2, userId: 'user-2' }),
      ];

      const result = service.buildBusinessTrend(records, 'week');

      expect(result).toHaveLength(2);
      expect(result[0].minute).toContain('2026-03-11');
      expect(result[1].minute).toContain('2026-03-12');
    });

    it('should count unique consultations per bucket', () => {
      const now = new Date('2026-03-11T10:00:00.000Z').getTime();
      const records = [
        buildRecord({ receivedAt: now, userId: 'user-1' }),
        buildRecord({ messageId: 'msg-2', receivedAt: now + 10 * 1000, userId: 'user-1' }), // same user
        buildRecord({ messageId: 'msg-3', receivedAt: now + 20 * 1000, userId: 'user-2' }),
      ];

      const result = service.buildBusinessTrend(records, 'today');

      expect(result[0].consultations).toBe(2); // 2 unique users
    });

    it('should count booking attempts from agentInvocation response', () => {
      const now = new Date('2026-03-11T10:00:00.000Z').getTime();
      const records = [
        buildRecord({
          receivedAt: now,
          userId: 'user-1',
          agentInvocation: {
            request: {},
            response: {
              messages: [
                {
                  parts: [
                    {
                      type: 'dynamic-tool',
                      toolName: 'duliday_interview_booking',
                      state: 'output-available',
                      output: { type: 'object', object: { success: true } },
                    },
                  ],
                },
              ],
            },
            isFallback: false,
          },
        }),
      ];

      const result = service.buildBusinessTrend(records, 'today');

      expect(result[0].bookingAttempts).toBe(1);
      expect(result[0].successfulBookings).toBe(1);
      expect(result[0].bookingSuccessRate).toBe(100);
    });

    it('should return sorted results by time ascending', () => {
      const day1 = new Date('2026-03-11T10:00:00.000Z').getTime();
      const day2 = new Date('2026-03-09T10:00:00.000Z').getTime();
      const records = [
        buildRecord({ receivedAt: day1 }),
        buildRecord({ messageId: 'msg-2', receivedAt: day2 }),
      ];

      const result = service.buildBusinessTrend(records, 'week');

      expect(new Date(result[0].minute).getTime()).toBeLessThan(
        new Date(result[1].minute).getTime(),
      );
    });

    it('should calculate conversionRate correctly', () => {
      const now = new Date('2026-03-11T10:00:00.000Z').getTime();
      const records = [
        buildRecord({ receivedAt: now, userId: 'user-1' }),
        buildRecord({ messageId: 'msg-2', receivedAt: now + 10 * 1000, userId: 'user-2' }),
      ];
      // No booking attempts, conversionRate should be 0
      const result = service.buildBusinessTrend(records, 'today');
      expect(result[0].conversionRate).toBe(0);
    });

    it('should skip records without userId for consultation count', () => {
      const now = new Date('2026-03-11T10:00:00.000Z').getTime();
      const records = [
        buildRecord({ receivedAt: now, userId: undefined }),
        buildRecord({ messageId: 'msg-2', receivedAt: now + 10 * 1000, userId: 'user-1' }),
      ];

      const result = service.buildBusinessTrend(records, 'today');

      expect(result[0].consultations).toBe(1); // only user-1
    });
  });
});

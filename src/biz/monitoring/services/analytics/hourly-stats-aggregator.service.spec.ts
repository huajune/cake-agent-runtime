import { Test, TestingModule } from '@nestjs/testing';
import { HourlyStatsAggregatorService } from './hourly-stats-aggregator.service';
import { MonitoringHourlyStatsRepository } from '../../repositories/monitoring-hourly-stats.repository';
import { HourlyStats } from '../../types/analytics.types';

const buildHourlyStats = (overrides: Partial<HourlyStats> = {}): HourlyStats => ({
  hour: '2026-03-11T00:00:00.000Z',
  messageCount: 100,
  successCount: 90,
  failureCount: 10,
  successRate: 90,
  avgDuration: 5000,
  minDuration: 1000,
  maxDuration: 60000,
  p50Duration: 4000,
  p95Duration: 20000,
  p99Duration: 50000,
  avgAiDuration: 3000,
  avgSendDuration: 1000,
  activeUsers: 20,
  activeChats: 15,
  totalTokenUsage: 5000,
  fallbackCount: 5,
  fallbackSuccessCount: 3,
  scenarioStats: {},
  toolStats: {},
  ...overrides,
});

describe('HourlyStatsAggregatorService', () => {
  let service: HourlyStatsAggregatorService;
  let _hourlyStatsRepository: jest.Mocked<MonitoringHourlyStatsRepository>;

  const mockHourlyStatsRepository = {
    getHourlyStatsByDateRange: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HourlyStatsAggregatorService,
        {
          provide: MonitoringHourlyStatsRepository,
          useValue: mockHourlyStatsRepository,
        },
      ],
    }).compile();

    service = module.get<HourlyStatsAggregatorService>(HourlyStatsAggregatorService);
    _hourlyStatsRepository = module.get(MonitoringHourlyStatsRepository);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========================================
  // getOverviewFromHourly
  // ========================================

  describe('getOverviewFromHourly', () => {
    it('should return aggregated overview stats from multiple hourly rows', async () => {
      const rows = [
        buildHourlyStats({
          messageCount: 100,
          successCount: 90,
          failureCount: 10,
          avgDuration: 5000,
          activeUsers: 20,
          activeChats: 15,
          totalTokenUsage: 3000,
        }),
        buildHourlyStats({
          messageCount: 50,
          successCount: 45,
          failureCount: 5,
          avgDuration: 4000,
          activeUsers: 10,
          activeChats: 8,
          totalTokenUsage: 2000,
        }),
      ];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getOverviewFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result.totalMessages).toBe(150);
      expect(result.successCount).toBe(135);
      expect(result.failureCount).toBe(15);
      expect(result.successRate).toBe(90);
      expect(result.activeUsers).toBe(30);
      expect(result.activeChats).toBe(23);
      expect(result.totalTokenUsage).toBe(5000);
      // Weighted avg: (5000 * 90 + 4000 * 45) / (90 + 45) = (450000 + 180000) / 135 = 4666.67 ≈ 4667
      expect(result.avgDuration).toBe(4667);
    });

    it('should return default zero stats when no rows exist', async () => {
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue([]);

      const result = await service.getOverviewFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result).toEqual({
        totalMessages: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        avgDuration: 0,
        activeUsers: 0,
        activeChats: 0,
        totalTokenUsage: 0,
      });
    });

    it('should calculate successRate correctly', async () => {
      const rows = [buildHourlyStats({ messageCount: 200, successCount: 160, failureCount: 40 })];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getOverviewFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result.successRate).toBe(80);
    });

    it('should handle rows with zero successCount for weighted avg', async () => {
      const rows = [
        buildHourlyStats({
          messageCount: 10,
          successCount: 0,
          failureCount: 10,
          avgDuration: 5000,
        }),
      ];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getOverviewFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result.avgDuration).toBe(0); // weightedAvg returns 0 when all weights are 0
    });
  });

  // ========================================
  // getFallbackFromHourly
  // ========================================

  describe('getFallbackFromHourly', () => {
    it('should return aggregated fallback stats from hourly rows', async () => {
      const rows = [
        buildHourlyStats({ fallbackCount: 10, fallbackSuccessCount: 7 }),
        buildHourlyStats({ fallbackCount: 5, fallbackSuccessCount: 4 }),
      ];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getFallbackFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result.totalCount).toBe(15);
      expect(result.successCount).toBe(11);
      expect(result.successRate).toBe(Math.round((11 / 15) * 100 * 100) / 100);
      expect(result.affectedUsers).toBe(0); // always 0 in hourly aggregation
    });

    it('should return zero successRate when totalCount is 0', async () => {
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue([
        buildHourlyStats({ fallbackCount: 0, fallbackSuccessCount: 0 }),
      ]);

      const result = await service.getFallbackFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result.successRate).toBe(0);
    });

    it('should handle empty rows', async () => {
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue([]);

      const result = await service.getFallbackFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result).toEqual({
        totalCount: 0,
        successCount: 0,
        successRate: 0,
        affectedUsers: 0,
      });
    });
  });

  // ========================================
  // getDailyTrendFromHourly
  // ========================================

  describe('getDailyTrendFromHourly', () => {
    it('should group hourly rows by date and aggregate per day', async () => {
      const rows = [
        buildHourlyStats({
          hour: '2026-03-11T00:00:00.000Z',
          messageCount: 50,
          successCount: 45,
          avgDuration: 4000,
          totalTokenUsage: 1000,
          activeUsers: 10,
        }),
        buildHourlyStats({
          hour: '2026-03-11T01:00:00.000Z',
          messageCount: 60,
          successCount: 55,
          avgDuration: 5000,
          totalTokenUsage: 1500,
          activeUsers: 12,
        }),
        buildHourlyStats({
          hour: '2026-03-12T00:00:00.000Z',
          messageCount: 80,
          successCount: 70,
          avgDuration: 6000,
          totalTokenUsage: 2000,
          activeUsers: 20,
        }),
      ];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getDailyTrendFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-13'),
      );

      expect(result).toHaveLength(2);
      expect(result[0].date).toBe('2026-03-11');
      expect(result[0].messageCount).toBe(110);
      expect(result[0].successCount).toBe(100);
      expect(result[0].tokenUsage).toBe(2500);
      expect(result[0].uniqueUsers).toBe(22);

      expect(result[1].date).toBe('2026-03-12');
      expect(result[1].messageCount).toBe(80);
    });

    it('should return results sorted by date ascending', async () => {
      const rows = [
        buildHourlyStats({ hour: '2026-03-13T00:00:00.000Z', messageCount: 30 }),
        buildHourlyStats({ hour: '2026-03-11T00:00:00.000Z', messageCount: 50 }),
        buildHourlyStats({ hour: '2026-03-12T00:00:00.000Z', messageCount: 40 }),
      ];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getDailyTrendFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-14'),
      );

      expect(result[0].date).toBe('2026-03-11');
      expect(result[1].date).toBe('2026-03-12');
      expect(result[2].date).toBe('2026-03-13');
    });

    it('should return empty array when no rows exist', async () => {
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue([]);

      const result = await service.getDailyTrendFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result).toEqual([]);
    });
  });

  // ========================================
  // getHourlyTrendFromHourly
  // ========================================

  describe('getHourlyTrendFromHourly', () => {
    it('should map hourly rows to HourlyTrendData format', async () => {
      const rows = [
        buildHourlyStats({
          hour: '2026-03-11T00:00:00.000Z',
          messageCount: 50,
          successCount: 45,
          avgDuration: 4000,
          totalTokenUsage: 1000,
          activeUsers: 10,
        }),
        buildHourlyStats({
          hour: '2026-03-11T01:00:00.000Z',
          messageCount: 30,
          successCount: 28,
          avgDuration: 3500,
          totalTokenUsage: 800,
          activeUsers: 8,
        }),
      ];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getHourlyTrendFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        hour: '2026-03-11T00:00:00.000Z',
        messageCount: 50,
        successCount: 45,
        avgDuration: 4000,
        tokenUsage: 1000,
        uniqueUsers: 10,
      });
    });

    it('should return empty array when no rows exist', async () => {
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue([]);

      const result = await service.getHourlyTrendFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result).toEqual([]);
    });
  });

  // ========================================
  // getMinuteTrendFromHourly
  // ========================================

  describe('getMinuteTrendFromHourly', () => {
    it('should return rows mapped to minute trend format with hour as minute key', async () => {
      const rows = [
        buildHourlyStats({
          hour: '2026-03-11T00:00:00.000Z',
          messageCount: 50,
          successCount: 45,
          avgDuration: 4000,
          activeUsers: 10,
        }),
      ];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getMinuteTrendFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        minute: '2026-03-11T00:00:00.000Z',
        messageCount: 50,
        successCount: 45,
        avgDuration: 4000,
        uniqueUsers: 10,
      });
    });
  });

  // ========================================
  // getScenarioFromHourly
  // ========================================

  describe('getScenarioFromHourly', () => {
    it('should aggregate scenario stats across hourly rows', async () => {
      const rows = [
        buildHourlyStats({
          scenarioStats: {
            job_consulting: { count: 30, successCount: 28, avgDuration: 3000 },
            greeting: { count: 20, successCount: 20, avgDuration: 1000 },
          },
        }),
        buildHourlyStats({
          scenarioStats: {
            job_consulting: { count: 10, successCount: 9, avgDuration: 4000 },
          },
        }),
      ];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getScenarioFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result).toHaveLength(2);
      const jobConsulting = result.find((s) => s.scenario === 'job_consulting');
      expect(jobConsulting).toBeDefined();
      expect(jobConsulting!.count).toBe(40);
      expect(jobConsulting!.successCount).toBe(37);
      // Weighted avg: (3000*30 + 4000*10) / 40 = (90000 + 40000) / 40 = 3250
      expect(jobConsulting!.avgDuration).toBe(3250);

      const greeting = result.find((s) => s.scenario === 'greeting');
      expect(greeting!.count).toBe(20);
    });

    it('should return results sorted by count descending', async () => {
      const rows = [
        buildHourlyStats({
          scenarioStats: {
            greeting: { count: 10, successCount: 10, avgDuration: 1000 },
            job_consulting: { count: 50, successCount: 45, avgDuration: 3000 },
          },
        }),
      ];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getScenarioFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result[0].scenario).toBe('job_consulting');
      expect(result[1].scenario).toBe('greeting');
    });

    it('should skip rows without scenarioStats', async () => {
      const rows = [
        buildHourlyStats({
          scenarioStats: undefined as unknown as Record<
            string,
            { count: number; successCount: number; avgDuration: number }
          >,
        }),
      ];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getScenarioFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result).toEqual([]);
    });
  });

  // ========================================
  // getToolFromHourly
  // ========================================

  describe('getToolFromHourly', () => {
    it('should aggregate tool usage across hourly rows', async () => {
      const rows = [
        buildHourlyStats({ toolStats: { duliday_interview_booking: 10, search: 5 } }),
        buildHourlyStats({ toolStats: { duliday_interview_booking: 7, search: 3 } }),
      ];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getToolFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ toolName: 'duliday_interview_booking', useCount: 17 });
      expect(result[1]).toEqual({ toolName: 'search', useCount: 8 });
    });

    it('should return results sorted by useCount descending', async () => {
      const rows = [buildHourlyStats({ toolStats: { search: 3, booking: 20 } })];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getToolFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result[0].toolName).toBe('booking');
      expect(result[1].toolName).toBe('search');
    });

    it('should skip rows without toolStats', async () => {
      const rows = [
        buildHourlyStats({ toolStats: undefined as unknown as Record<string, number> }),
      ];
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue(rows);

      const result = await service.getToolFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result).toEqual([]);
    });

    it('should return empty array when no rows exist', async () => {
      mockHourlyStatsRepository.getHourlyStatsByDateRange.mockResolvedValue([]);

      const result = await service.getToolFromHourly(
        new Date('2026-03-11'),
        new Date('2026-03-12'),
      );

      expect(result).toEqual([]);
    });
  });

  // ========================================
  // mergeOverviewStats
  // ========================================

  describe('mergeOverviewStats', () => {
    it('should correctly merge two overview stats objects', () => {
      const a = {
        totalMessages: 100,
        successCount: 90,
        failureCount: 10,
        successRate: 90,
        avgDuration: 5000,
        activeUsers: 20,
        activeChats: 15,
        totalTokenUsage: 3000,
      };

      const b = {
        totalMessages: 50,
        successCount: 40,
        failureCount: 10,
        successRate: 80,
        avgDuration: 4000,
        activeUsers: 10,
        activeChats: 8,
        totalTokenUsage: 2000,
      };

      const result = service.mergeOverviewStats(a, b);

      expect(result.totalMessages).toBe(150);
      expect(result.successCount).toBe(130);
      expect(result.failureCount).toBe(20);
      expect(result.successRate).toBe(Math.round((130 / 150) * 100 * 100) / 100);
      expect(result.activeUsers).toBe(30);
      expect(result.activeChats).toBe(23);
      expect(result.totalTokenUsage).toBe(5000);
      // Weighted avg: (5000*90 + 4000*40) / 130 = (450000 + 160000) / 130 ≈ 4692
      expect(result.avgDuration).toBe(4692);
    });

    it('should return zero successRate when totalMessages is 0', () => {
      const empty = {
        totalMessages: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        avgDuration: 0,
        activeUsers: 0,
        activeChats: 0,
        totalTokenUsage: 0,
      };

      const result = service.mergeOverviewStats(empty, empty);

      expect(result.successRate).toBe(0);
      expect(result.avgDuration).toBe(0);
    });
  });

  // ========================================
  // mergeFallbackStats
  // ========================================

  describe('mergeFallbackStats', () => {
    it('should correctly merge two fallback stats objects', () => {
      const a = { totalCount: 10, successCount: 8, successRate: 80, affectedUsers: 5 };
      const b = { totalCount: 5, successCount: 3, successRate: 60, affectedUsers: 3 };

      const result = service.mergeFallbackStats(a, b);

      expect(result.totalCount).toBe(15);
      expect(result.successCount).toBe(11);
      expect(result.successRate).toBe(Math.round((11 / 15) * 100 * 100) / 100);
      expect(result.affectedUsers).toBe(8);
    });

    it('should return zero successRate when totalCount is 0', () => {
      const empty = { totalCount: 0, successCount: 0, successRate: 0, affectedUsers: 0 };

      const result = service.mergeFallbackStats(empty, empty);

      expect(result.successRate).toBe(0);
    });
  });
});

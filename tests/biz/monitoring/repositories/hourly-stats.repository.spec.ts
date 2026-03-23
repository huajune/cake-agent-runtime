import { Test, TestingModule } from '@nestjs/testing';
import { MonitoringHourlyStatsRepository } from '@biz/monitoring/repositories/hourly-stats.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { HourlyStatsRecord } from '@biz/monitoring/types/repository.types';

function makeQueryMock(result: { data?: unknown; error?: unknown; count?: number }) {
  const chainMethods = [
    'select',
    'insert',
    'update',
    'upsert',
    'delete',
    'eq',
    'neq',
    'gte',
    'lte',
    'gt',
    'lt',
    'in',
    'or',
    'order',
    'limit',
    'range',
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mock: any = Object.assign(Promise.resolve(result), {});
  for (const m of chainMethods) {
    mock[m] = jest.fn().mockReturnValue(mock);
  }
  return mock;
}

const sampleStats: HourlyStatsRecord = {
  hour: '2026-03-10T10:00:00Z',
  messageCount: 42,
  successCount: 40,
  failureCount: 2,
  successRate: 0.952,
  avgDuration: 1200,
  minDuration: 800,
  maxDuration: 3000,
  p50Duration: 1100,
  p95Duration: 2500,
  p99Duration: 2900,
  avgAiDuration: 1000,
  avgSendDuration: 200,
  activeUsers: 15,
  activeChats: 12,
  totalTokenUsage: 5000,
  fallbackCount: 1,
  fallbackSuccessCount: 1,
  scenarioStats: { interview: { count: 30, successCount: 28, avgDuration: 1100 } },
  toolStats: { search: 10, calendar: 5 },
};

describe('MonitoringHourlyStatsRepository', () => {
  let repository: MonitoringHourlyStatsRepository;

  const mockSupabaseClient = {
    from: jest.fn(),
    rpc: jest.fn(),
  };

  const mockSupabaseService = {
    getSupabaseClient: jest.fn().mockReturnValue(mockSupabaseClient),
    isClientInitialized: jest.fn().mockReturnValue(true),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSupabaseService.getSupabaseClient.mockReturnValue(mockSupabaseClient);
    mockSupabaseService.isClientInitialized.mockReturnValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonitoringHourlyStatsRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<MonitoringHourlyStatsRepository>(MonitoringHourlyStatsRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== saveHourlyStats ====================

  describe('saveHourlyStats', () => {
    it('should upsert hourly stats', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const upsertResult = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(upsertResult);

      await repository.saveHourlyStats(sampleStats);

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('monitoring_hourly_stats');
    });

    it('should not throw on upsert error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const errorResult = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(errorResult);

      await expect(repository.saveHourlyStats(sampleStats)).resolves.not.toThrow();
    });

    it('should handle stats with default optional fields', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const upsertResult = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(upsertResult);

      const minimalStats: HourlyStatsRecord = {
        ...sampleStats,
        totalTokenUsage: undefined,
        fallbackCount: undefined,
        fallbackSuccessCount: undefined,
        scenarioStats: undefined,
        toolStats: undefined,
      };

      await expect(repository.saveHourlyStats(minimalStats)).resolves.not.toThrow();
    });
  });

  // ==================== saveHourlyStatsBatch ====================

  describe('saveHourlyStatsBatch', () => {
    it('should skip empty array', async () => {
      await repository.saveHourlyStatsBatch([]);

      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should skip null/undefined input', async () => {
      await repository.saveHourlyStatsBatch(null as unknown as HourlyStatsRecord[]);

      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should upsert batch of hourly stats', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const upsertResult = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(upsertResult);

      const statsList: HourlyStatsRecord[] = [
        { ...sampleStats, hour: '2026-03-10T10:00:00Z' },
        { ...sampleStats, hour: '2026-03-10T11:00:00Z' },
      ];

      await expect(repository.saveHourlyStatsBatch(statsList)).resolves.not.toThrow();

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('monitoring_hourly_stats');
    });
  });

  // ==================== getRecentHourlyStats ====================

  describe('getRecentHourlyStats', () => {
    it('should return hourly stats in descending order', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const dbRows = [
        {
          hour: '2026-03-10T11:00:00Z',
          message_count: 50,
          success_count: 48,
          failure_count: 2,
          success_rate: 0.96,
          avg_duration: 1100,
          min_duration: 700,
          max_duration: 2800,
          p50_duration: 1000,
          p95_duration: 2400,
          p99_duration: 2700,
          avg_ai_duration: 900,
          avg_send_duration: 200,
          active_users: 18,
          active_chats: 14,
          total_token_usage: 6000,
          fallback_count: 2,
          fallback_success_count: 2,
          scenario_stats: {},
          tool_stats: {},
        },
      ];

      const queryMock = makeQueryMock({ data: dbRows, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getRecentHourlyStats(72);

      expect(result).toHaveLength(1);
      expect(result[0].hour).toBe('2026-03-10T11:00:00Z');
      expect(result[0].messageCount).toBe(50);
      expect(result[0].successRate).toBeCloseTo(0.96);
    });

    it('should use default hours of 72', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getRecentHourlyStats();

      expect(result).toEqual([]);
    });

    it('should return empty array on error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getRecentHourlyStats();

      expect(result).toEqual([]);
    });

    it('should handle stats with null optional fields', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const dbRows = [
        {
          hour: '2026-03-10T10:00:00Z',
          message_count: 10,
          success_count: 10,
          failure_count: 0,
          success_rate: 1.0,
          avg_duration: 1000,
          min_duration: 800,
          max_duration: 1200,
          p50_duration: 950,
          p95_duration: 1150,
          p99_duration: 1190,
          avg_ai_duration: 800,
          avg_send_duration: 200,
          active_users: 5,
          active_chats: 4,
          total_token_usage: null,
          fallback_count: null,
          fallback_success_count: null,
          scenario_stats: null,
          tool_stats: null,
        },
      ];

      const queryMock = makeQueryMock({ data: dbRows, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getRecentHourlyStats();

      expect(result).toHaveLength(1);
      expect(result[0].totalTokenUsage).toBe(0);
      expect(result[0].fallbackCount).toBe(0);
      expect(result[0].fallbackSuccessCount).toBe(0);
      expect(result[0].scenarioStats).toEqual({});
      expect(result[0].toolStats).toEqual({});
    });
  });

  // ==================== getHourlyStatsByDateRange ====================

  describe('getHourlyStatsByDateRange', () => {
    it('should return stats within date range', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const dbRows = [
        {
          hour: '2026-03-10T10:00:00Z',
          message_count: 30,
          success_count: 28,
          failure_count: 2,
          success_rate: 0.933,
          avg_duration: 1200,
          min_duration: 900,
          max_duration: 2500,
          p50_duration: 1100,
          p95_duration: 2300,
          p99_duration: 2400,
          avg_ai_duration: 1000,
          avg_send_duration: 200,
          active_users: 10,
          active_chats: 8,
          total_token_usage: 3500,
          fallback_count: 0,
          fallback_success_count: 0,
          scenario_stats: {},
          tool_stats: {},
        },
      ];

      const queryMock = makeQueryMock({ data: dbRows, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const startDate = new Date('2026-03-10T00:00:00Z');
      const endDate = new Date('2026-03-11T00:00:00Z');
      const result = await repository.getHourlyStatsByDateRange(startDate, endDate);

      expect(result).toHaveLength(1);
      expect(result[0].hour).toBe('2026-03-10T10:00:00Z');
    });

    it('should return empty array when no stats in range', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getHourlyStatsByDateRange(new Date(), new Date());

      expect(result).toEqual([]);
    });
  });

  // ==================== clearAllRecords ====================

  describe('clearAllRecords', () => {
    it('should skip when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      await repository.clearAllRecords();

      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should delete all records when supabase is available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const deleteResult = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(deleteResult);

      await expect(repository.clearAllRecords()).resolves.not.toThrow();

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('monitoring_hourly_stats');
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { MonitoringDailyStatsRepository } from '@biz/monitoring/repositories/daily-stats.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { DailyStatsRecord } from '@biz/monitoring/types/repository.types';

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

const sampleDailyStats: DailyStatsRecord = {
  date: '2026-04-16',
  messageCount: 120,
  successCount: 100,
  failureCount: 15,
  timeoutCount: 5,
  successRate: 83.33,
  avgDuration: 1500,
  tokenUsage: 8000,
  uniqueUsers: 40,
  uniqueChats: 30,
  fallbackCount: 8,
  fallbackSuccessCount: 6,
  fallbackAffectedUsers: 5,
  avgQueueDuration: 250,
  avgPrepDuration: 180,
  errorTypeStats: { agent: 3, timeout: 5 },
};

describe('MonitoringDailyStatsRepository', () => {
  let repository: MonitoringDailyStatsRepository;

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
        MonitoringDailyStatsRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<MonitoringDailyStatsRepository>(MonitoringDailyStatsRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  describe('saveDailyStats', () => {
    it('should map camelCase fields to database columns on upsert', async () => {
      const upsertResult = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(upsertResult);

      await repository.saveDailyStats(sampleDailyStats);

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('monitoring_daily_stats');
      expect(upsertResult.upsert).toHaveBeenCalledWith(
        {
          stat_date: '2026-04-16',
          message_count: 120,
          success_count: 100,
          failure_count: 15,
          timeout_count: 5,
          success_rate: 83.33,
          avg_duration: 1500,
          total_token_usage: 8000,
          unique_users: 40,
          unique_chats: 30,
          fallback_count: 8,
          fallback_success_count: 6,
          fallback_affected_users: 5,
          avg_queue_duration: 250,
          avg_prep_duration: 180,
          error_type_stats: { agent: 3, timeout: 5 },
        },
        { onConflict: 'stat_date' },
      );
    });
  });

  describe('getLatestDailyStat', () => {
    it('should map database fields back to application fields with defaults for nullable values', async () => {
      const queryMock = makeQueryMock({
        data: [
          {
            stat_date: '2026-04-16',
            message_count: 20,
            success_count: 18,
            failure_count: 2,
            timeout_count: null,
            success_rate: 90,
            avg_duration: 1300,
            total_token_usage: null,
            unique_users: null,
            unique_chats: null,
            fallback_count: null,
            fallback_success_count: null,
            fallback_affected_users: null,
            avg_queue_duration: null,
            avg_prep_duration: null,
            error_type_stats: null,
          },
        ],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getLatestDailyStat();

      expect(result).toEqual({
        date: '2026-04-16',
        messageCount: 20,
        successCount: 18,
        failureCount: 2,
        timeoutCount: 0,
        successRate: 90,
        avgDuration: 1300,
        tokenUsage: 0,
        uniqueUsers: 0,
        uniqueChats: 0,
        fallbackCount: 0,
        fallbackSuccessCount: 0,
        fallbackAffectedUsers: 0,
        avgQueueDuration: 0,
        avgPrepDuration: 0,
        errorTypeStats: {},
      });
      expect(queryMock.order).toHaveBeenCalledWith('stat_date', { ascending: false });
      expect(queryMock.limit).toHaveBeenCalledWith(1);
    });

    it('should return null when no daily stats exist', async () => {
      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getLatestDailyStat();

      expect(result).toBeNull();
    });
  });

  describe('getDailyStatsByDateRange', () => {
    it('should pass formatted date boundaries to the query', async () => {
      const queryMock = makeQueryMock({
        data: [
          {
            stat_date: '2026-04-16',
            message_count: 120,
            success_count: 100,
            failure_count: 15,
            timeout_count: 5,
            success_rate: 83.33,
            avg_duration: 1500,
            total_token_usage: 8000,
            unique_users: 40,
            unique_chats: 30,
            fallback_count: 8,
            fallback_success_count: 6,
            fallback_affected_users: 5,
            avg_queue_duration: 250,
            avg_prep_duration: 180,
            error_type_stats: { agent: 3, timeout: 5 },
          },
        ],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const startDate = new Date('2026-04-16T04:00:00.000Z');
      const endDate = new Date('2026-04-17T04:00:00.000Z');
      const result = await repository.getDailyStatsByDateRange(startDate, endDate);

      expect(queryMock.gte).toHaveBeenCalledWith('stat_date', '2026-04-16');
      expect(queryMock.lt).toHaveBeenCalledWith('stat_date', '2026-04-17');
      expect(queryMock.order).toHaveBeenCalledWith('stat_date', { ascending: true });
      expect(result).toEqual([sampleDailyStats]);
    });
  });
});

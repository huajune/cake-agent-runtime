import { Test, TestingModule } from '@nestjs/testing';
import { MonitoringRecordRepository } from '@biz/monitoring/repositories/record.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';

describe('MonitoringRecordRepository', () => {
  let repository: MonitoringRecordRepository;

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
        MonitoringRecordRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<MonitoringRecordRepository>(MonitoringRecordRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== getDashboardOverviewStats ====================

  describe('getDashboardOverviewStats', () => {
    it('should return default zeros when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getDashboardOverviewStats(new Date(), new Date());

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

    it('should return mapped overview stats from RPC', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [
          {
            total_messages: '100',
            success_count: '95',
            failure_count: '5',
            success_rate: '0.95',
            avg_duration: '1200.5',
            active_users: '30',
            active_chats: '25',
            total_token_usage: '15000',
          },
        ],
        error: null,
      });

      const result = await repository.getDashboardOverviewStats(new Date(), new Date());

      expect(result.totalMessages).toBe(100);
      expect(result.successCount).toBe(95);
      expect(result.failureCount).toBe(5);
      expect(result.successRate).toBeCloseTo(0.95);
      expect(result.avgDuration).toBeCloseTo(1200.5);
      expect(result.activeUsers).toBe(30);
      expect(result.activeChats).toBe(25);
      expect(result.totalTokenUsage).toBe(15000);
    });

    it('should return defaults when RPC returns empty array', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: [], error: null });

      const result = await repository.getDashboardOverviewStats(new Date(), new Date());

      expect(result.totalMessages).toBe(0);
    });

    it('should return defaults when RPC returns null', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      const result = await repository.getDashboardOverviewStats(new Date(), new Date());

      expect(result.totalMessages).toBe(0);
    });

    it('should return defaults on RPC error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockRejectedValue(new Error('RPC failed'));

      const result = await repository.getDashboardOverviewStats(new Date(), new Date());

      expect(result.totalMessages).toBe(0);
    });
  });

  // ==================== getDashboardFallbackStats ====================

  describe('getDashboardFallbackStats', () => {
    it('should return default zeros when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getDashboardFallbackStats(new Date(), new Date());

      expect(result).toEqual({
        totalCount: 0,
        successCount: 0,
        successRate: 0,
        affectedUsers: 0,
      });
    });

    it('should return mapped fallback stats from RPC', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [
          {
            fallback_total: '8',
            fallback_success: '6',
            fallback_success_rate: '0.75',
            fallback_affected_users: '5',
          },
        ],
        error: null,
      });

      const result = await repository.getDashboardFallbackStats(new Date(), new Date());

      expect(result.totalCount).toBe(8);
      expect(result.successCount).toBe(6);
      expect(result.successRate).toBeCloseTo(0.75);
      expect(result.affectedUsers).toBe(5);
    });
  });

  // ==================== getDashboardDailyTrend ====================

  describe('getDashboardDailyTrend', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getDashboardDailyTrend(new Date(), new Date());

      expect(result).toEqual([]);
    });

    it('should return mapped daily trend data', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [
          {
            date: '2026-03-10',
            message_count: '42',
            success_count: '40',
            avg_duration: '1100.0',
            token_usage: '4500',
            unique_users: '15',
          },
        ],
        error: null,
      });

      const result = await repository.getDashboardDailyTrend(new Date(), new Date());

      expect(result).toHaveLength(1);
      expect(result[0].date).toBe('2026-03-10');
      expect(result[0].messageCount).toBe(42);
      expect(result[0].successCount).toBe(40);
    });

    it('should return empty array when RPC returns null', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      const result = await repository.getDashboardDailyTrend(new Date(), new Date());

      expect(result).toEqual([]);
    });
  });

  // ==================== getDashboardHourlyTrend ====================

  describe('getDashboardHourlyTrend', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getDashboardHourlyTrend(new Date(), new Date());

      expect(result).toEqual([]);
    });

    it('should return mapped hourly trend data', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [
          {
            hour: '2026-03-10T10:00:00Z',
            message_count: '15',
            success_count: '14',
            avg_duration: '1050.0',
            token_usage: '1500',
            unique_users: '8',
          },
        ],
        error: null,
      });

      const result = await repository.getDashboardHourlyTrend(new Date(), new Date());

      expect(result).toHaveLength(1);
      expect(result[0].hour).toBe('2026-03-10T10:00:00Z');
      expect(result[0].messageCount).toBe(15);
    });
  });

  // ==================== getDashboardMinuteTrend ====================

  describe('getDashboardMinuteTrend', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getDashboardMinuteTrend(new Date(), new Date());

      expect(result).toEqual([]);
    });

    it('should return mapped minute trend data with default interval', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [
          {
            minute: '2026-03-10T10:05:00Z',
            message_count: '3',
            success_count: '3',
            avg_duration: '1100.0',
            unique_users: '2',
          },
        ],
        error: null,
      });

      const result = await repository.getDashboardMinuteTrend(new Date(), new Date());

      expect(result).toHaveLength(1);
      expect(result[0].minute).toBe('2026-03-10T10:05:00Z');
      expect(result[0].messageCount).toBe(3);
    });

    it('should pass custom interval minutes to RPC', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: [], error: null });

      const start = new Date('2026-03-10T10:00:00Z');
      const end = new Date('2026-03-10T11:00:00Z');
      await repository.getDashboardMinuteTrend(start, end, 10);

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
        'get_dashboard_minute_trend',
        expect.objectContaining({ p_interval_minutes: 10 }),
      );
    });
  });

  // ==================== getDashboardScenarioStats ====================

  describe('getDashboardScenarioStats', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getDashboardScenarioStats(new Date(), new Date());

      expect(result).toEqual([]);
    });

    it('should return mapped scenario stats', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [
          {
            scenario: 'interview',
            count: '30',
            success_count: '28',
            avg_duration: '1200.0',
          },
          {
            scenario: 'general',
            count: '15',
            success_count: '15',
            avg_duration: '900.0',
          },
        ],
        error: null,
      });

      const result = await repository.getDashboardScenarioStats(new Date(), new Date());

      expect(result).toHaveLength(2);
      expect(result[0].scenario).toBe('interview');
      expect(result[0].count).toBe(30);
      expect(result[1].scenario).toBe('general');
    });
  });

  // ==================== getDashboardToolStats ====================

  describe('getDashboardToolStats', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getDashboardToolStats(new Date(), new Date());

      expect(result).toEqual([]);
    });

    it('should return mapped tool stats', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [
          { tool_name: 'search', use_count: '25' },
          { tool_name: 'calendar', use_count: '10' },
        ],
        error: null,
      });

      const result = await repository.getDashboardToolStats(new Date(), new Date());

      expect(result).toHaveLength(2);
      expect(result[0].toolName).toBe('search');
      expect(result[0].useCount).toBe(25);
    });
  });

  // ==================== aggregateHourlyStats ====================

  describe('aggregateHourlyStats', () => {
    it('should return null when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.aggregateHourlyStats(new Date(), new Date());

      expect(result).toBeNull();
    });

    it('should return zero aggregate when RPC returns empty array', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: [], error: null });

      const result = await repository.aggregateHourlyStats(new Date(), new Date());

      expect(result).toEqual({
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
    });

    it('should return mapped aggregated stats', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [
          {
            message_count: '42',
            success_count: '40',
            failure_count: '2',
            success_rate: '0.952',
            avg_duration: '1200.0',
            min_duration: '800.0',
            max_duration: '3000.0',
            p50_duration: '1100.0',
            p95_duration: '2500.0',
            p99_duration: '2900.0',
            avg_ai_duration: '1000.0',
            avg_send_duration: '200.0',
            active_users: '15',
            active_chats: '12',
            total_token_usage: '5000',
            fallback_count: '1',
            fallback_success_count: '1',
            scenario_stats: { interview: { count: 30 } },
            tool_stats: { search: 10 },
          },
        ],
        error: null,
      });

      const result = await repository.aggregateHourlyStats(new Date(), new Date());

      expect(result).not.toBeNull();
      expect(result!.messageCount).toBe(42);
      expect(result!.successCount).toBe(40);
      expect(result!.failureCount).toBe(2);
      expect(result!.successRate).toBeCloseTo(0.952);
      expect(result!.activeUsers).toBe(15);
      expect(result!.fallbackCount).toBe(1);
      expect(result!.scenarioStats).toEqual({ interview: { count: 30 } });
      expect(result!.toolStats).toEqual({ search: 10 });
    });

    it('should return null on RPC error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockRejectedValue(new Error('RPC error'));

      const result = await repository.aggregateHourlyStats(new Date(), new Date());

      expect(result).toBeNull();
    });

    it('should pass correct date params to RPC', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: [], error: null });

      const hourStart = new Date('2026-03-10T10:00:00Z');
      const hourEnd = new Date('2026-03-10T11:00:00Z');
      await repository.aggregateHourlyStats(hourStart, hourEnd);

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('aggregate_hourly_stats', {
        p_hour_start: hourStart.toISOString(),
        p_hour_end: hourEnd.toISOString(),
      });
    });
  });
});

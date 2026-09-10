import { OpsEventsAnalyticsRepository } from '@biz/conversion-analytics/repositories/ops-events-analytics.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';

type RepositoryWithSelectAllPaged = OpsEventsAnalyticsRepository & {
  selectAllPaged<T>(
    table: string,
    columns?: string,
    modifier?: (query: unknown) => unknown,
  ): Promise<T[]>;
};

describe('OpsEventsAnalyticsRepository', () => {
  const repository = new OpsEventsAnalyticsRepository({
    getSupabaseClient: jest.fn(),
    isClientInitialized: jest.fn().mockReturnValue(true),
  } as unknown as SupabaseService);

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('reads ops_events through selectAllPaged and appends stable id ordering', async () => {
    const selectAllPagedSpy = jest
      .spyOn(repository as RepositoryWithSelectAllPaged, 'selectAllPaged')
      .mockResolvedValue([{ id: 1 }]);

    await expect(
      repository.findOpsEvents('event_name, report_date', (q) =>
        (q as { eq: jest.Mock }).eq('event_name', 'friend.added'),
      ),
    ).resolves.toEqual([{ id: 1 }]);

    expect(selectAllPagedSpy).toHaveBeenCalledWith(
      'ops_events',
      'event_name, report_date',
      expect.any(Function),
    );
    const query = {
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
    };
    selectAllPagedSpy.mock.calls[0][2]?.(query);
    expect(query.eq).toHaveBeenCalledWith('event_name', 'friend.added');
    expect(query.order).toHaveBeenCalledWith('id', { ascending: true });
  });

  it('reads daily_ops_report rows with the same paged stable ordering', async () => {
    const selectAllPagedSpy = jest
      .spyOn(repository as RepositoryWithSelectAllPaged, 'selectAllPaged')
      .mockResolvedValue([{ id: 1 }]);

    await repository.findDailyOpsReportRows('report_date, booking_success_count', (q) =>
      (q as { gte: jest.Mock }).gte('report_date', '2026-06-01'),
    );

    expect(selectAllPagedSpy).toHaveBeenCalledWith(
      'daily_ops_report',
      'report_date, booking_success_count',
      expect.any(Function),
    );
    const query = {
      gte: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
    };
    selectAllPagedSpy.mock.calls[0][2]?.(query);
    expect(query.gte).toHaveBeenCalledWith('report_date', '2026-06-01');
    expect(query.order).toHaveBeenCalledWith('id', { ascending: true });
  });
});

type RepositoryWithRpcAllPaged = OpsEventsAnalyticsRepository & {
  rpcAllPaged<T>(functionName: string, params?: Record<string, unknown>): Promise<T[]>;
};

describe('OpsEventsAnalyticsRepository — 聚合 RPC', () => {
  const repository = new OpsEventsAnalyticsRepository({
    getSupabaseClient: jest.fn(),
    isClientInitialized: jest.fn().mockReturnValue(true),
  } as unknown as SupabaseService);

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('period 统计走 conversion_period_stats，未选小组时小组参数传 null', async () => {
    const rpcSpy = jest
      .spyOn(repository as RepositoryWithRpcAllPaged, 'rpcAllPaged')
      .mockResolvedValue([]);

    await repository.findPeriodStats({
      startDate: '2026-09-01',
      endDate: '2026-09-07',
      groups: [],
    });

    expect(rpcSpy).toHaveBeenCalledWith('conversion_period_stats', {
      p_start_date: '2026-09-01',
      p_end_date: '2026-09-07',
      p_corp_id: null,
      p_groups: null,
      p_group_bot_ids: null,
    });
  });

  it('cohort 统计带观察截止日与小组 bot 归属', async () => {
    const rpcSpy = jest
      .spyOn(repository as RepositoryWithRpcAllPaged, 'rpcAllPaged')
      .mockResolvedValue([]);

    await repository.findCohortStats({
      startDate: '2026-08-25',
      endDate: '2026-08-31',
      observeEndDate: '2026-09-07',
      groups: ['小祝组'],
      groupBotIds: ['bot-a'],
    });

    expect(rpcSpy).toHaveBeenCalledWith('conversion_cohort_stats', {
      p_base_start: '2026-08-25',
      p_base_end: '2026-08-31',
      p_observe_end: '2026-09-07',
      p_corp_id: null,
      p_groups: ['小祝组'],
      p_group_bot_ids: ['bot-a'],
    });
  });

  it('RPC 失败时返回空数组，不回退到明细翻页', async () => {
    jest.spyOn(repository as RepositoryWithRpcAllPaged, 'rpcAllPaged').mockResolvedValue([]);
    const pagedSpy = jest.spyOn(repository as RepositoryWithSelectAllPaged, 'selectAllPaged');

    await expect(
      repository.findHandoffReasons({ startDate: '2026-09-01', endDate: '2026-09-07' }),
    ).resolves.toEqual([]);
    expect(pagedSpy).not.toHaveBeenCalled();
  });
});

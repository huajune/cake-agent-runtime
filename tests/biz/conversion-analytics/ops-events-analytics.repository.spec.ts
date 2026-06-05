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

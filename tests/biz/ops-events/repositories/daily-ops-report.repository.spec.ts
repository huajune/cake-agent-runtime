import { DailyOpsReportRepository } from '@biz/ops-events/repositories/daily-ops-report.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';

type RepositoryWithSelectAllPaged = DailyOpsReportRepository & {
  selectAllPaged<T>(
    table: string,
    columns?: string,
    modifier?: (query: unknown) => unknown,
  ): Promise<T[]>;
};
type RepositoryWithSelectOne = DailyOpsReportRepository & {
  selectOne<T>(columns?: string, modifier?: (query: unknown) => unknown): Promise<T | null>;
};

describe('DailyOpsReportRepository', () => {
  const repository = new DailyOpsReportRepository({
    getSupabaseClient: jest.fn(),
    isClientInitialized: jest.fn().mockReturnValue(true),
  } as unknown as SupabaseService);

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('sums every projected metric across the date range', async () => {
    jest.spyOn(repository as RepositoryWithSelectAllPaged, 'selectAllPaged').mockResolvedValue([
      {
        friends_added_count: 1,
        agent_opening_sent_count: 2,
        break_ice_count: 3,
        candidate_message_count: 4,
        agent_reply_count: 5,
        job_recommend_count: 6,
        precheck_pass_count: 7,
        booking_success_count: 8,
        booking_fail_count: 9,
        group_invite_count: 10,
        handoff_count: 11,
        interview_pass_count: 12,
      },
      {
        friends_added_count: 10,
        agent_opening_sent_count: null,
        break_ice_count: 30,
        candidate_message_count: 40,
        agent_reply_count: 50,
        job_recommend_count: 60,
        precheck_pass_count: 70,
        booking_success_count: 80,
        booking_fail_count: 90,
        group_invite_count: 100,
        handoff_count: 110,
        interview_pass_count: 120,
      },
    ]);

    await expect(repository.sumByDateRange('2026-06-01', '2026-06-05')).resolves.toEqual({
      friendsAdded: 11,
      openingSent: 2,
      breakIce: 33,
      candidateMessage: 44,
      agentReply: 55,
      jobRecommend: 66,
      precheckPass: 77,
      bookingSuccess: 88,
      bookingFail: 99,
      groupInvite: 110,
      handoff: 121,
      interviewPass: 132,
      rowCount: 2,
    });
  });

  it('sums booking success by report date', async () => {
    jest.spyOn(repository as RepositoryWithSelectAllPaged, 'selectAllPaged').mockResolvedValue([
      { report_date: '2026-06-01', booking_success_count: 2 },
      { report_date: '2026-06-01', booking_success_count: 3 },
      { report_date: '2026-06-02', booking_success_count: null },
      { report_date: '2026-06-03', booking_success_count: 4 },
    ]);

    await expect(
      repository.sumBookingSuccessByDateRange('2026-06-01', '2026-06-03'),
    ).resolves.toEqual([
      { date: '2026-06-01', bookingSuccess: 5 },
      { date: '2026-06-02', bookingSuccess: 0 },
      { date: '2026-06-03', bookingSuccess: 4 },
    ]);
  });

  it('uses paged stable reads for report rows and earliest date lookup', async () => {
    const selectAllPagedSpy = jest
      .spyOn(repository as RepositoryWithSelectAllPaged, 'selectAllPaged')
      .mockResolvedValue([]);
    const selectOneSpy = jest
      .spyOn(repository as RepositoryWithSelectOne, 'selectOne')
      .mockResolvedValue({ report_date: '2026-05-29' });

    await repository.findByReportDate('2026-06-05');
    await expect(repository.getEarliestReportDate()).resolves.toBe('2026-05-29');

    expect(selectAllPagedSpy).toHaveBeenCalledWith('daily_ops_report', '*', expect.any(Function));
    const reportQuery = {
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
    };
    selectAllPagedSpy.mock.calls[0][2]?.(reportQuery);
    expect(reportQuery.eq).toHaveBeenCalledWith('report_date', '2026-06-05');
    expect(reportQuery.order).toHaveBeenCalledWith('id', { ascending: true });

    expect(selectOneSpy).toHaveBeenCalledWith('report_date', expect.any(Function));
  });
});

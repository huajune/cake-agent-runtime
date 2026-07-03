import { DailyOpsReportRepository } from '@biz/ops-events/repositories/daily-ops-report.repository';
import { DailyOpsReportService } from '@biz/ops-events/services/daily-ops-report.service';

describe('DailyOpsReportService', () => {
  const repository = {
    findByReportDate: jest.fn(),
    sumByDateRange: jest.fn(),
    sumBookingSuccessByDateRange: jest.fn(),
    getEarliestReportDate: jest.fn(),
  };
  const service = new DailyOpsReportService(repository as unknown as DailyOpsReportRepository);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates daily report reads through the service boundary', async () => {
    repository.findByReportDate.mockResolvedValueOnce([{ report_date: '2026-06-09' }]);

    await expect(service.findByReportDate('2026-06-09')).resolves.toEqual([
      { report_date: '2026-06-09' },
    ]);

    expect(repository.findByReportDate).toHaveBeenCalledWith('2026-06-09');
  });

  it('delegates summary reads through the service boundary', async () => {
    repository.getEarliestReportDate.mockResolvedValueOnce('2026-06-01');
    repository.sumByDateRange.mockResolvedValueOnce({ bookingSuccess: 3 });
    repository.sumBookingSuccessByDateRange.mockResolvedValueOnce([
      { date: '2026-06-09', bookingSuccess: 3 },
    ]);

    await expect(service.getEarliestReportDate()).resolves.toBe('2026-06-01');
    await expect(service.sumByDateRange('2026-06-01', '2026-06-09')).resolves.toEqual({
      bookingSuccess: 3,
    });
    await expect(service.sumBookingSuccessByDateRange('2026-06-01', '2026-06-09')).resolves.toEqual(
      [{ date: '2026-06-09', bookingSuccess: 3 }],
    );
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { MonitoringDailyStatsRepository } from '@biz/monitoring/repositories/daily-stats.repository';
import { DailyStatsAggregatorService } from '@biz/monitoring/services/projections/daily-stats-aggregator.service';

describe('DailyStatsAggregatorService', () => {
  let service: DailyStatsAggregatorService;
  let dailyStatsRepository: jest.Mocked<MonitoringDailyStatsRepository>;

  const mockDailyStatsRepository = {
    getDailyStatsByDateRange: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailyStatsAggregatorService,
        {
          provide: MonitoringDailyStatsRepository,
          useValue: mockDailyStatsRepository,
        },
      ],
    }).compile();

    service = module.get(DailyStatsAggregatorService);
    dailyStatsRepository = module.get(MonitoringDailyStatsRepository);

    jest.clearAllMocks();
  });

  it('should map daily projection rows to dashboard trend format', async () => {
    dailyStatsRepository.getDailyStatsByDateRange.mockResolvedValue([
      {
        date: '2026-04-14',
        messageCount: 40,
        successCount: 36,
        failureCount: 4,
        timeoutCount: 1,
        successRate: 90,
        avgDuration: 3200,
        tokenUsage: 1800,
        uniqueUsers: 12,
        uniqueChats: 10,
        fallbackCount: 2,
        fallbackSuccessCount: 1,
        fallbackAffectedUsers: 1,
        avgQueueDuration: 700,
        avgPrepDuration: 300,
        errorTypeStats: { agent: 1 },
      },
    ]);

    const result = await service.getDailyTrendFromDaily(
      new Date('2026-04-14T00:00:00.000Z'),
      new Date('2026-04-15T00:00:00.000Z'),
    );

    expect(result).toEqual([
      {
        date: '2026-04-14',
        messageCount: 40,
        successCount: 36,
        avgDuration: 3200,
        tokenUsage: 1800,
        uniqueUsers: 12,
      },
    ]);
  });
});

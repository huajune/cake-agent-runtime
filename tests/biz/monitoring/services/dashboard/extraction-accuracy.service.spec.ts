import { Test, TestingModule } from '@nestjs/testing';
import { ExtractionAccuracyService } from '@biz/monitoring/services/dashboard/extraction-accuracy.service';
import { ExtractionAccuracyRepository } from '@biz/monitoring/repositories/extraction-accuracy.repository';
import { ExtractionAccuracyFieldRow } from '@biz/monitoring/types/analytics.types';

describe('ExtractionAccuracyService', () => {
  let service: ExtractionAccuracyService;
  const getReport = jest.fn();

  const sampleRows: ExtractionAccuracyFieldRow[] = [
    {
      field: 'phone',
      bookings: 40,
      extracted: 12,
      coveragePct: 30.0,
      accuracyPct: 100.0,
      mismatches: 0,
      highConf: 10,
      highConfAccuracyPct: 100.0,
    },
  ];

  beforeEach(async () => {
    jest.clearAllMocks();
    getReport.mockResolvedValue(sampleRows);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExtractionAccuracyService,
        { provide: ExtractionAccuracyRepository, useValue: { getReport } },
      ],
    }).compile();

    service = module.get<ExtractionAccuracyService>(ExtractionAccuracyService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should default to a 14-day window and return repository rows', async () => {
    const result = await service.getReport();

    expect(result.days).toBe(14);
    expect(result.fields).toEqual(sampleRows);

    const [start, end] = getReport.mock.calls[0];
    const spanDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeCloseTo(14, 5);
    expect(result.start).toBe(start.toISOString());
    expect(result.end).toBe(end.toISOString());
  });

  it('should honor a custom days value', async () => {
    const result = await service.getReport(7);

    expect(result.days).toBe(7);
    const [start, end] = getReport.mock.calls[0];
    const spanDays = (end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBeCloseTo(7, 5);
  });

  it('should clamp invalid days to the default and cap the max', async () => {
    const invalid = await service.getReport(0);
    expect(invalid.days).toBe(14);

    const capped = await service.getReport(9999);
    expect(capped.days).toBe(90);
  });
});

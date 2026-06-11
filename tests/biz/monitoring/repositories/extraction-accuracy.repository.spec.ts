import { Test, TestingModule } from '@nestjs/testing';
import { ExtractionAccuracyRepository } from '@biz/monitoring/repositories/extraction-accuracy.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';

describe('ExtractionAccuracyRepository', () => {
  let repository: ExtractionAccuracyRepository;

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
        ExtractionAccuracyRepository,
        { provide: SupabaseService, useValue: mockSupabaseService },
      ],
    }).compile();

    repository = module.get<ExtractionAccuracyRepository>(ExtractionAccuracyRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  it('should return empty array when supabase is not available', async () => {
    mockSupabaseService.isClientInitialized.mockReturnValue(false);

    const result = await repository.getReport(new Date('2026-06-01'), new Date('2026-06-15'));

    expect(result).toEqual([]);
    expect(mockSupabaseClient.rpc).not.toHaveBeenCalled();
  });

  it('should call the RPC with ISO time window and map snake_case rows', async () => {
    mockSupabaseClient.rpc.mockResolvedValue({
      data: [
        {
          field: 'name',
          bookings: '40',
          extracted: '38',
          coverage_pct: '95.0',
          accuracy_pct: '92.1',
          mismatches: '3',
          high_conf: '30',
          high_conf_accuracy_pct: '96.7',
        },
      ],
      error: null,
    });

    const start = new Date('2026-06-01T00:00:00.000Z');
    const end = new Date('2026-06-15T00:00:00.000Z');
    const result = await repository.getReport(start, end);

    expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('extraction_accuracy_report', {
      p_start: start.toISOString(),
      p_end: end.toISOString(),
    });
    expect(result).toEqual([
      {
        field: 'name',
        bookings: 40,
        extracted: 38,
        coveragePct: 95.0,
        accuracyPct: 92.1,
        mismatches: 3,
        highConf: 30,
        highConfAccuracyPct: 96.7,
      },
    ]);
  });

  it('should return empty array when RPC returns null (missing/circuit)', async () => {
    mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

    const result = await repository.getReport(new Date(), new Date());

    expect(result).toEqual([]);
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { TestBatchRepository } from '@biz/test-suite/repositories/test-batch.repository';
import { SupabaseService } from '@core/supabase';
import { BatchStatus, BatchSource, TestType } from '@biz/test-suite/enums/test.enum';

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

const sampleBatch = {
  id: 'batch_001',
  name: 'Test Batch 1',
  source: BatchSource.MANUAL,
  feishu_table_id: null,
  status: BatchStatus.CREATED,
  test_type: TestType.SCENARIO,
  total_cases: 0,
  executed_count: 0,
  passed_count: 0,
  failed_count: 0,
  pending_review_count: 0,
  pass_rate: null,
  avg_duration_ms: null,
  avg_token_usage: null,
  created_at: '2026-03-10T00:00:00Z',
  completed_at: null,
};

describe('TestBatchRepository', () => {
  let repository: TestBatchRepository;

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
        TestBatchRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<TestBatchRepository>(TestBatchRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== create ====================

  describe('create', () => {
    it('should insert batch with CREATED status and default source', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const insertResult = makeQueryMock({ data: [sampleBatch], error: null });
      mockSupabaseClient.from.mockReturnValue(insertResult);

      const result = await repository.create({ name: 'Test Batch 1' });

      expect(result).toEqual(sampleBatch);
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('test_batches');
    });

    it('should create batch with FEISHU source', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const feishuBatch = {
        ...sampleBatch,
        source: BatchSource.FEISHU,
        feishu_table_id: 'table_id',
      };
      const insertResult = makeQueryMock({ data: [feishuBatch], error: null });
      mockSupabaseClient.from.mockReturnValue(insertResult);

      const result = await repository.create({
        name: 'Feishu Batch',
        source: BatchSource.FEISHU,
        feishuTableId: 'table_id',
      });

      expect(result.source).toBe(BatchSource.FEISHU);
    });

    it('should create conversation type batch', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const convBatch = { ...sampleBatch, test_type: TestType.CONVERSATION };
      const insertResult = makeQueryMock({ data: [convBatch], error: null });
      mockSupabaseClient.from.mockReturnValue(insertResult);

      const result = await repository.create({
        name: 'Conv Batch',
        testType: TestType.CONVERSATION,
      });

      expect(result.test_type).toBe(TestType.CONVERSATION);
    });
  });

  // ==================== findMany ====================

  describe('findMany', () => {
    it('should return empty result when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.findMany();

      expect(result).toEqual({ data: [], total: 0 });
    });

    it('should return paginated list with total count', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const selectResult = {
        select: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({
          data: [sampleBatch],
          error: null,
          count: 1,
        }),
      };
      mockSupabaseClient.from.mockReturnValue(selectResult);

      const result = await repository.findMany(20, 0);

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should filter by testType when provided', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const selectResult = {
        select: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockReturnThis(),
        eq: jest.fn().mockResolvedValue({
          data: [sampleBatch],
          error: null,
          count: 1,
        }),
      };
      mockSupabaseClient.from.mockReturnValue(selectResult);

      const result = await repository.findMany(20, 0, TestType.SCENARIO);

      expect(result.data).toHaveLength(1);
    });

    it('should handle database error gracefully', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const selectResult = {
        select: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        range: jest.fn().mockResolvedValue({
          data: null,
          error: { message: 'DB error', code: '42P01' },
          count: null,
        }),
      };
      mockSupabaseClient.from.mockReturnValue(selectResult);

      const result = await repository.findMany();

      expect(result).toEqual({ data: [], total: 0 });
    });
  });

  // ==================== findById ====================

  describe('findById', () => {
    it('should return null when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.findById('batch_001');

      expect(result).toBeNull();
    });

    it('should return batch when found', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [sampleBatch], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findById('batch_001');

      expect(result).toEqual(sampleBatch);
    });

    it('should return null when batch not found', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ==================== updateStatus ====================

  describe('updateStatus', () => {
    it('should throw when batch does not exist', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      await expect(repository.updateStatus('nonexistent', BatchStatus.RUNNING)).rejects.toThrow(
        '批次 nonexistent 不存在',
      );
    });

    it('should throw on invalid state transition', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      // Return batch in COMPLETED status (terminal state)
      const completedBatch = { ...sampleBatch, status: BatchStatus.COMPLETED };
      const queryMock = makeQueryMock({ data: [completedBatch], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      await expect(repository.updateStatus('batch_001', BatchStatus.RUNNING)).rejects.toThrow(
        '非法状态转换',
      );
    });

    it('should update status on valid transition (created → running)', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const createdBatch = { ...sampleBatch, status: BatchStatus.CREATED };
      const updatedBatch = { ...sampleBatch, status: BatchStatus.RUNNING };

      // First call for findById, second call for update
      mockSupabaseClient.from
        .mockReturnValueOnce(makeQueryMock({ data: [createdBatch], error: null }))
        .mockReturnValue(makeQueryMock({ data: [updatedBatch], error: null }));

      await expect(
        repository.updateStatus('batch_001', BatchStatus.RUNNING),
      ).resolves.not.toThrow();
    });

    it('should update status on valid transition (running → reviewing)', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const runningBatch = { ...sampleBatch, status: BatchStatus.RUNNING };
      const reviewingBatch = { ...sampleBatch, status: BatchStatus.REVIEWING };

      mockSupabaseClient.from
        .mockReturnValueOnce(makeQueryMock({ data: [runningBatch], error: null }))
        .mockReturnValue(makeQueryMock({ data: [reviewingBatch], error: null }));

      await expect(
        repository.updateStatus('batch_001', BatchStatus.REVIEWING),
      ).resolves.not.toThrow();
    });

    it('should silently ignore when transitioning to same status (idempotent)', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const runningBatch = { ...sampleBatch, status: BatchStatus.RUNNING };
      const queryMock = makeQueryMock({ data: [runningBatch], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      await expect(
        repository.updateStatus('batch_001', BatchStatus.RUNNING),
      ).resolves.not.toThrow();
    });

    it('should set completed_at when transitioning to COMPLETED', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const reviewingBatch = { ...sampleBatch, status: BatchStatus.REVIEWING };
      const completedBatch = { ...sampleBatch, status: BatchStatus.COMPLETED };

      mockSupabaseClient.from
        .mockReturnValueOnce(makeQueryMock({ data: [reviewingBatch], error: null }))
        .mockReturnValue(makeQueryMock({ data: [completedBatch], error: null }));

      await repository.updateStatus('batch_001', BatchStatus.COMPLETED);

      // update was called on the second from() call
      expect(mockSupabaseClient.from).toHaveBeenCalledTimes(2);
    });

    it('should allow cancellation from created state', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const createdBatch = { ...sampleBatch, status: BatchStatus.CREATED };
      const cancelledBatch = { ...sampleBatch, status: BatchStatus.CANCELLED };

      mockSupabaseClient.from
        .mockReturnValueOnce(makeQueryMock({ data: [createdBatch], error: null }))
        .mockReturnValue(makeQueryMock({ data: [cancelledBatch], error: null }));

      await expect(
        repository.updateStatus('batch_001', BatchStatus.CANCELLED),
      ).resolves.not.toThrow();
    });
  });

  // ==================== updateStats ====================

  describe('updateStats', () => {
    it('should update batch statistics', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updateResult = makeQueryMock({ data: [sampleBatch], error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      await expect(
        repository.updateStats('batch_001', {
          totalCases: 10,
          executedCount: 8,
          passedCount: 7,
          failedCount: 1,
          pendingReviewCount: 0,
          passRate: 0.875,
          avgDurationMs: 1200,
          avgTokenUsage: 500,
        }),
      ).resolves.not.toThrow();

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('test_batches');
    });

    it('should handle partial stats update', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updateResult = makeQueryMock({ data: [sampleBatch], error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      await expect(
        repository.updateStats('batch_001', {
          totalCases: 5,
          executedCount: 3,
          passedCount: 2,
          failedCount: 1,
          pendingReviewCount: 2,
          passRate: 0.667,
          avgDurationMs: null,
          avgTokenUsage: null,
        }),
      ).resolves.not.toThrow();
    });
  });
});

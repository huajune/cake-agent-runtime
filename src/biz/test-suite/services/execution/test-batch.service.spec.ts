import { Test, TestingModule } from '@nestjs/testing';
import { TestBatchService } from './test-batch.service';
import { TestBatchRepository } from '../../repositories/test-batch.repository';
import { TestExecutionRepository } from '../../repositories/test-execution.repository';
import { TestStatsService } from './test-stats.service';
import { TestWriteBackService } from '../feishu/test-write-back.service';
import {
  BatchStatus,
  ReviewStatus,
  FeishuTestStatus,
  BatchSource,
  TestType,
} from '../../enums/test.enum';
import { TestExecution } from '../../entities/test-execution.entity';
import { TestBatch } from '../../entities/test-batch.entity';

describe('TestBatchService', () => {
  let service: TestBatchService;
  let batchRepository: jest.Mocked<TestBatchRepository>;
  let executionRepository: jest.Mocked<TestExecutionRepository>;
  let statsService: jest.Mocked<TestStatsService>;
  let writeBackService: jest.Mocked<TestWriteBackService>;

  const mockBatchRepository = {
    create: jest.fn(),
    findMany: jest.fn(),
    findById: jest.fn(),
    updateStatus: jest.fn(),
    updateStats: jest.fn(),
  };

  const mockExecutionRepository = {
    findByBatchId: jest.fn(),
    findByBatchIdForList: jest.fn(),
    findById: jest.fn(),
    updateReview: jest.fn(),
    batchUpdateReview: jest.fn(),
  };

  const mockStatsService = {
    calculateBatchStats: jest.fn(),
    calculateCategoryStats: jest.fn(),
    calculateFailureReasonStats: jest.fn(),
  };

  const mockWriteBackService = {
    writeBackResult: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestBatchService,
        { provide: TestBatchRepository, useValue: mockBatchRepository },
        { provide: TestExecutionRepository, useValue: mockExecutionRepository },
        { provide: TestStatsService, useValue: mockStatsService },
        { provide: TestWriteBackService, useValue: mockWriteBackService },
      ],
    }).compile();

    service = module.get<TestBatchService>(TestBatchService);
    batchRepository = module.get(TestBatchRepository);
    executionRepository = module.get(TestExecutionRepository);
    statsService = module.get(TestStatsService);
    writeBackService = module.get(TestWriteBackService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========== createBatch ==========

  describe('createBatch', () => {
    it('should create a batch with provided parameters', async () => {
      const mockBatch = { id: 'batch-1', name: 'Test Batch' } as TestBatch;
      mockBatchRepository.create.mockResolvedValue(mockBatch);

      const result = await service.createBatch({
        name: 'Test Batch',
        source: BatchSource.MANUAL,
        feishuAppToken: 'app-token',
        feishuTableId: 'table-id',
        testType: TestType.SCENARIO,
      });

      expect(batchRepository.create).toHaveBeenCalledWith({
        name: 'Test Batch',
        source: BatchSource.MANUAL,
        feishuAppToken: 'app-token',
        feishuTableId: 'table-id',
        testType: TestType.SCENARIO,
      });
      expect(result).toBe(mockBatch);
    });
  });

  // ========== getBatches ==========

  describe('getBatches', () => {
    it('should return batches with default pagination', async () => {
      const mockResult = { data: [], total: 0 };
      mockBatchRepository.findMany.mockResolvedValue(mockResult);

      const result = await service.getBatches();

      expect(batchRepository.findMany).toHaveBeenCalledWith(20, 0, undefined);
      expect(result).toBe(mockResult);
    });

    it('should pass custom limit, offset, and testType to repository', async () => {
      mockBatchRepository.findMany.mockResolvedValue({ data: [], total: 0 });

      await service.getBatches(10, 5, TestType.CONVERSATION);

      expect(batchRepository.findMany).toHaveBeenCalledWith(10, 5, TestType.CONVERSATION);
    });
  });

  // ========== getBatch ==========

  describe('getBatch', () => {
    it('should return batch by id', async () => {
      const mockBatch = { id: 'batch-1' } as TestBatch;
      mockBatchRepository.findById.mockResolvedValue(mockBatch);

      const result = await service.getBatch('batch-1');

      expect(batchRepository.findById).toHaveBeenCalledWith('batch-1');
      expect(result).toBe(mockBatch);
    });

    it('should return null for non-existent batch', async () => {
      mockBatchRepository.findById.mockResolvedValue(null);

      const result = await service.getBatch('non-existent');

      expect(result).toBeNull();
    });
  });

  // ========== getBatchExecutions ==========

  describe('getBatchExecutions', () => {
    it('should return executions for the batch', async () => {
      const mockExecutions = [{ id: 'exec-1' }, { id: 'exec-2' }] as TestExecution[];
      mockExecutionRepository.findByBatchId.mockResolvedValue(mockExecutions);

      const result = await service.getBatchExecutions('batch-1');

      expect(executionRepository.findByBatchId).toHaveBeenCalledWith('batch-1', undefined);
      expect(result).toBe(mockExecutions);
    });

    it('should pass filters to the repository', async () => {
      mockExecutionRepository.findByBatchId.mockResolvedValue([]);
      const filters = { reviewStatus: ReviewStatus.FAILED };

      await service.getBatchExecutions('batch-1', filters);

      expect(executionRepository.findByBatchId).toHaveBeenCalledWith('batch-1', filters);
    });
  });

  // ========== getBatchExecutionsForList ==========

  describe('getBatchExecutionsForList', () => {
    it('should call the list variant of the repository method', async () => {
      mockExecutionRepository.findByBatchIdForList.mockResolvedValue([]);

      await service.getBatchExecutionsForList('batch-1', { category: 'FAQ' });

      expect(executionRepository.findByBatchIdForList).toHaveBeenCalledWith('batch-1', {
        category: 'FAQ',
      });
    });
  });

  // ========== updateBatchStatus ==========

  describe('updateBatchStatus', () => {
    it('should update batch status via repository', async () => {
      mockBatchRepository.updateStatus.mockResolvedValue(undefined);

      await service.updateBatchStatus('batch-1', BatchStatus.RUNNING);

      expect(batchRepository.updateStatus).toHaveBeenCalledWith('batch-1', BatchStatus.RUNNING);
    });
  });

  // ========== updateBatchStats ==========

  describe('updateBatchStats', () => {
    it('should calculate stats and persist them', async () => {
      const mockStats = {
        totalCases: 10,
        executedCount: 8,
        passedCount: 6,
        failedCount: 2,
        pendingReviewCount: 2,
        passRate: 60,
        avgDurationMs: 1500,
        avgTokenUsage: 200,
      };
      mockStatsService.calculateBatchStats.mockResolvedValue(mockStats);
      mockBatchRepository.updateStats.mockResolvedValue(undefined);

      await service.updateBatchStats('batch-1');

      expect(statsService.calculateBatchStats).toHaveBeenCalledWith('batch-1');
      expect(batchRepository.updateStats).toHaveBeenCalledWith('batch-1', mockStats);
    });
  });

  // ========== getBatchStats ==========

  describe('getBatchStats', () => {
    it('should delegate to statsService', async () => {
      const mockStats = { totalCases: 5 } as any;
      mockStatsService.calculateBatchStats.mockResolvedValue(mockStats);

      const result = await service.getBatchStats('batch-1');

      expect(statsService.calculateBatchStats).toHaveBeenCalledWith('batch-1');
      expect(result).toBe(mockStats);
    });
  });

  // ========== getCategoryStats ==========

  describe('getCategoryStats', () => {
    it('should delegate to statsService', async () => {
      const mockCategoryStats = [{ category: 'FAQ', total: 3, passed: 2, failed: 1 }];
      mockStatsService.calculateCategoryStats.mockResolvedValue(mockCategoryStats);

      const result = await service.getCategoryStats('batch-1');

      expect(statsService.calculateCategoryStats).toHaveBeenCalledWith('batch-1');
      expect(result).toBe(mockCategoryStats);
    });
  });

  // ========== getFailureReasonStats ==========

  describe('getFailureReasonStats', () => {
    it('should delegate to statsService', async () => {
      const mockReasonStats = [{ reason: 'wrong_answer', count: 3, percentage: 75 }];
      mockStatsService.calculateFailureReasonStats.mockResolvedValue(mockReasonStats);

      const result = await service.getFailureReasonStats('batch-1');

      expect(statsService.calculateFailureReasonStats).toHaveBeenCalledWith('batch-1');
      expect(result).toBe(mockReasonStats);
    });
  });

  // ========== updateReview ==========

  describe('updateReview', () => {
    const mockExecution = {
      id: 'exec-1',
      batch_id: 'batch-1',
      case_id: 'case-feishu-1',
      review_status: ReviewStatus.PASSED,
    } as TestExecution;

    const mockStats = {
      totalCases: 5,
      executedCount: 5,
      passedCount: 5,
      failedCount: 0,
      pendingReviewCount: 0,
      passRate: 100,
      avgDurationMs: 1000,
      avgTokenUsage: null,
    };

    beforeEach(() => {
      mockExecutionRepository.updateReview.mockResolvedValue(undefined);
      mockExecutionRepository.findById.mockResolvedValue(mockExecution);
      mockStatsService.calculateBatchStats.mockResolvedValue(mockStats);
      mockBatchRepository.updateStats.mockResolvedValue(undefined);
      mockBatchRepository.updateStatus.mockResolvedValue(undefined);
      mockWriteBackService.writeBackResult.mockResolvedValue({ success: true });
    });

    it('should update review and return updated execution', async () => {
      const review = { reviewStatus: ReviewStatus.PASSED, reviewComment: 'Great' };

      const result = await service.updateReview('exec-1', review);

      expect(executionRepository.updateReview).toHaveBeenCalledWith(
        'exec-1',
        expect.objectContaining({ reviewStatus: ReviewStatus.PASSED }),
      );
      expect(result).toBe(mockExecution);
    });

    it('should throw error when execution not found', async () => {
      mockExecutionRepository.findById.mockResolvedValue(null);

      await expect(
        service.updateReview('non-existent', { reviewStatus: ReviewStatus.PASSED }),
      ).rejects.toThrow('执行记录不存在');
    });

    it('should update batch status to COMPLETED when all cases are reviewed', async () => {
      const review = { reviewStatus: ReviewStatus.PASSED };

      await service.updateReview('exec-1', review);

      expect(batchRepository.updateStatus).toHaveBeenCalledWith('batch-1', BatchStatus.COMPLETED);
    });

    it('should not update batch status when pendingReviewCount > 0', async () => {
      mockStatsService.calculateBatchStats.mockResolvedValue({
        ...mockStats,
        pendingReviewCount: 2,
      });

      await service.updateReview('exec-1', { reviewStatus: ReviewStatus.PASSED });

      expect(batchRepository.updateStatus).not.toHaveBeenCalled();
    });

    it('should trigger async feishu write-back when case_id exists and status is not pending', async () => {
      const review = { reviewStatus: ReviewStatus.PASSED };

      await service.updateReview('exec-1', review);

      // Write-back is async - wait for microtask queue
      await new Promise((resolve) => setImmediate(resolve));

      expect(writeBackService.writeBackResult).toHaveBeenCalledWith(
        'case-feishu-1',
        FeishuTestStatus.PASSED,
        'batch-1',
        undefined,
      );
    });

    it('should NOT trigger feishu write-back when review status is PENDING', async () => {
      const review = { reviewStatus: ReviewStatus.PENDING };

      await service.updateReview('exec-1', review);

      await new Promise((resolve) => setImmediate(resolve));

      expect(writeBackService.writeBackResult).not.toHaveBeenCalled();
    });

    it('should map FAILED review status to FAILED feishu status', async () => {
      const executionWithFailure = { ...mockExecution, case_id: 'case-2' } as TestExecution;
      mockExecutionRepository.findById.mockResolvedValue(executionWithFailure);

      const review = { reviewStatus: ReviewStatus.FAILED, failureReason: 'wrong_answer' };
      await service.updateReview('exec-1', review);

      await new Promise((resolve) => setImmediate(resolve));

      expect(writeBackService.writeBackResult).toHaveBeenCalledWith(
        'case-2',
        FeishuTestStatus.FAILED,
        'batch-1',
        'wrong_answer',
      );
    });

    it('should map SKIPPED review status to SKIPPED feishu status', async () => {
      mockExecutionRepository.findById.mockResolvedValue(mockExecution);

      const review = { reviewStatus: ReviewStatus.SKIPPED };
      await service.updateReview('exec-1', review);

      await new Promise((resolve) => setImmediate(resolve));

      expect(writeBackService.writeBackResult).toHaveBeenCalledWith(
        'case-feishu-1',
        FeishuTestStatus.SKIPPED,
        'batch-1',
        undefined,
      );
    });

    it('should NOT trigger feishu write-back when execution has no case_id', async () => {
      const executionNoCaseId = { ...mockExecution, case_id: null } as unknown as TestExecution;
      mockExecutionRepository.findById.mockResolvedValue(executionNoCaseId);

      await service.updateReview('exec-1', { reviewStatus: ReviewStatus.PASSED });

      await new Promise((resolve) => setImmediate(resolve));

      expect(writeBackService.writeBackResult).not.toHaveBeenCalled();
    });
  });

  // ========== batchUpdateReview ==========

  describe('batchUpdateReview', () => {
    it('should update multiple executions and return count', async () => {
      const updatedExecutions = [
        { id: 'exec-1', batch_id: 'batch-1' },
        { id: 'exec-2', batch_id: 'batch-1' },
      ] as TestExecution[];
      mockExecutionRepository.batchUpdateReview.mockResolvedValue(updatedExecutions);
      mockStatsService.calculateBatchStats.mockResolvedValue({
        totalCases: 2,
        executedCount: 2,
        passedCount: 2,
        failedCount: 0,
        pendingReviewCount: 0,
        passRate: 100,
        avgDurationMs: null,
        avgTokenUsage: null,
      });
      mockBatchRepository.updateStats.mockResolvedValue(undefined);

      const result = await service.batchUpdateReview(['exec-1', 'exec-2'], {
        reviewStatus: ReviewStatus.PASSED,
      });

      expect(executionRepository.batchUpdateReview).toHaveBeenCalledWith(
        ['exec-1', 'exec-2'],
        expect.objectContaining({ reviewStatus: ReviewStatus.PASSED }),
      );
      expect(result).toBe(2);
    });

    it('should update stats for all affected batches', async () => {
      const updatedExecutions = [
        { id: 'exec-1', batch_id: 'batch-1' },
        { id: 'exec-2', batch_id: 'batch-2' },
      ] as TestExecution[];
      mockExecutionRepository.batchUpdateReview.mockResolvedValue(updatedExecutions);
      mockStatsService.calculateBatchStats.mockResolvedValue({
        totalCases: 1,
        executedCount: 1,
        passedCount: 1,
        failedCount: 0,
        pendingReviewCount: 0,
        passRate: 100,
        avgDurationMs: null,
        avgTokenUsage: null,
      });
      mockBatchRepository.updateStats.mockResolvedValue(undefined);

      await service.batchUpdateReview(['exec-1', 'exec-2'], {
        reviewStatus: ReviewStatus.PASSED,
      });

      // Two distinct batches should each have their stats updated
      expect(statsService.calculateBatchStats).toHaveBeenCalledTimes(2);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { TestBatchService } from '@biz/test-suite/services/test-batch.service';
import { TestBatchRepository } from '@biz/test-suite/repositories/test-batch.repository';
import { TestExecutionRepository } from '@biz/test-suite/repositories/test-execution.repository';
import { TestWriteBackService } from '@biz/test-suite/services/test-write-back.service';
import { TestExecutionService } from '@biz/test-suite/services/test-execution.service';
import { ConversationSnapshotRepository } from '@biz/test-suite/repositories/conversation-snapshot.repository';
import {
  BatchStatus,
  ReviewStatus,
  ReviewerSource,
  FeishuTestStatus,
  BatchSource,
  TestType,
} from '@biz/test-suite/enums/test.enum';
import { TestExecution } from '@biz/test-suite/entities/test-execution.entity';
import { TestBatch } from '@biz/test-suite/entities/test-batch.entity';

describe('TestBatchService', () => {
  let service: TestBatchService;
  let batchRepository: jest.Mocked<TestBatchRepository>;
  let executionRepository: jest.Mocked<TestExecutionRepository>;
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
    findByBatchIdLite: jest.fn(),
    findByBatchIdForList: jest.fn(),
    findById: jest.fn(),
    updateReview: jest.fn(),
    batchUpdateReview: jest.fn(),
  };

  const mockWriteBackService = {
    writeBackResult: jest.fn(),
  };

  const mockExecutionService = {
    saveExecution: jest.fn(),
    executeTest: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockConversationSnapshotRepository = {
    create: jest.fn(),
    findById: jest.fn(),
    findByBatchId: jest.fn(),
    countByBatchIdGroupByStatus: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestBatchService,
        { provide: TestBatchRepository, useValue: mockBatchRepository },
        { provide: TestExecutionRepository, useValue: mockExecutionRepository },
        { provide: ConversationSnapshotRepository, useValue: mockConversationSnapshotRepository },
        { provide: TestWriteBackService, useValue: mockWriteBackService },
        { provide: TestExecutionService, useValue: mockExecutionService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<TestBatchService>(TestBatchService);
    batchRepository = module.get(TestBatchRepository);
    executionRepository = module.get(TestExecutionRepository);
    writeBackService = module.get(TestWriteBackService);

    jest.clearAllMocks();
    mockConfigService.get.mockReturnValue(undefined);
    mockBatchRepository.findById.mockResolvedValue({
      id: 'batch-1',
      status: BatchStatus.REVIEWING,
      test_type: TestType.SCENARIO,
    } as TestBatch);
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
        feishuTableId: 'table-id',
        testType: TestType.SCENARIO,
      });

      expect(batchRepository.create).toHaveBeenCalledWith({
        name: 'Test Batch',
        source: BatchSource.MANUAL,
        feishuTableId: 'table-id',
        testType: TestType.SCENARIO,
      });
      expect(result).toBe(mockBatch);
    });

    it.each([
      ['反馈验证 SOP 2026-04-24 场景补跑 bc-4cpob79w', '2026-04-24 场景补跑 bc-4cpob79w'],
      ['反馈验证 SOP：2026-04-24 场景测试', '2026-04-24 用例测试'],
      ['反馈验证 SOP 2026-04-24 回归验证', '2026-04-24 回归验证'],
      ['反馈验证 SOP 2026-04-24 对话验证', '2026-04-24 回归验证'],
    ])(
      'should normalize generated feedback validation name "%s"',
      async (inputName, expectedName) => {
        const mockBatch = { id: 'batch-1', name: expectedName } as TestBatch;
        mockBatchRepository.create.mockResolvedValue(mockBatch);

        await service.createBatch({
          name: inputName,
          source: BatchSource.FEISHU,
          testType: TestType.SCENARIO,
        });

        expect(batchRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            name: expectedName,
          }),
        );
      },
    );
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
    it('should calculate stats internally and persist them', async () => {
      const mockExecutions = [
        {
          execution_status: 'completed',
          review_status: 'passed',
          duration_ms: 1000,
          token_usage: 100,
        },
        {
          execution_status: 'completed',
          review_status: 'failed',
          duration_ms: 2000,
          token_usage: 200,
        },
      ] as unknown as TestExecution[];
      mockExecutionRepository.findByBatchIdLite.mockResolvedValue(mockExecutions);
      mockBatchRepository.updateStats.mockResolvedValue(undefined);

      await service.updateBatchStats('batch-1');

      expect(batchRepository.updateStats).toHaveBeenCalledWith(
        'batch-1',
        expect.objectContaining({
          totalCases: 2,
        }),
      );
    });

    it('should auto-complete conversation batch when all conversations are done', async () => {
      mockBatchRepository.findById.mockResolvedValue({
        id: 'batch-1',
        status: BatchStatus.REVIEWING,
        test_type: TestType.CONVERSATION,
      } as TestBatch);
      mockConversationSnapshotRepository.countByBatchIdGroupByStatus.mockResolvedValue({
        total: 2,
        pending: 0,
        running: 0,
        completed: 2,
        failed: 0,
      });
      mockConversationSnapshotRepository.findByBatchId.mockResolvedValue([
        { status: 'completed', avg_similarity_score: 71 },
        { status: 'completed', avg_similarity_score: 50 },
      ] as any);
      mockBatchRepository.updateStats.mockResolvedValue(undefined);
      mockBatchRepository.updateStatus.mockResolvedValue(undefined);

      await service.updateBatchStats('batch-1');

      expect(batchRepository.updateStats).toHaveBeenCalledWith(
        'batch-1',
        expect.objectContaining({
          totalCases: 2,
          executedCount: 2,
          pendingReviewCount: 0,
          passRate: 61,
        }),
      );
      expect(batchRepository.updateStatus).toHaveBeenCalledWith('batch-1', BatchStatus.COMPLETED);
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
      // Mock findByBatchIdLite for internal stats calculation
      mockExecutionRepository.findByBatchIdLite.mockResolvedValue([
        { execution_status: 'completed', review_status: 'passed', duration_ms: 1000 },
        { execution_status: 'completed', review_status: 'passed', duration_ms: 1000 },
        { execution_status: 'completed', review_status: 'passed', duration_ms: 1000 },
        { execution_status: 'completed', review_status: 'passed', duration_ms: 1000 },
        { execution_status: 'completed', review_status: 'passed', duration_ms: 1000 },
      ] as unknown as TestExecution[]);
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
      mockExecutionRepository.findByBatchIdLite.mockResolvedValue([
        { execution_status: 'completed', review_status: 'passed', duration_ms: 1000 },
        { execution_status: 'completed', review_status: 'pending', duration_ms: 1000 },
        { execution_status: 'completed', review_status: 'pending', duration_ms: 1000 },
      ] as unknown as TestExecution[]);

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
        '人工评审通过',
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
        '人工评审失败：wrong_answer',
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
        '人工评审跳过',
      );
    });

    it('should use codex reviewer source in feishu summary when provided', async () => {
      await service.updateReview('exec-1', {
        reviewStatus: ReviewStatus.PASSED,
        reviewedBy: 'codex-runtime',
        reviewerSource: ReviewerSource.CODEX,
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(writeBackService.writeBackResult).toHaveBeenCalledWith(
        'case-feishu-1',
        FeishuTestStatus.PASSED,
        'batch-1',
        undefined,
        'Codex评审通过',
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
        { id: 'exec-1', batch_id: 'batch-1', case_id: 'rec-1' },
        { id: 'exec-2', batch_id: 'batch-1', case_id: 'rec-2' },
      ] as TestExecution[];
      mockExecutionRepository.batchUpdateReview.mockResolvedValue(updatedExecutions);
      mockExecutionRepository.findByBatchIdLite.mockResolvedValue([
        { execution_status: 'completed', review_status: 'passed' },
      ] as unknown as TestExecution[]);
      mockBatchRepository.updateStats.mockResolvedValue(undefined);
      mockWriteBackService.writeBackResult.mockResolvedValue({ success: true });

      const result = await service.batchUpdateReview(['exec-1', 'exec-2'], {
        reviewStatus: ReviewStatus.PASSED,
        reviewComment: 'Codex评审通过',
        reviewerSource: ReviewerSource.CODEX,
      });

      expect(executionRepository.batchUpdateReview).toHaveBeenCalledWith(
        ['exec-1', 'exec-2'],
        expect.objectContaining({ reviewStatus: ReviewStatus.PASSED }),
      );
      expect(result).toBe(2);
      expect(writeBackService.writeBackResult).toHaveBeenCalledTimes(2);
      expect(writeBackService.writeBackResult).toHaveBeenCalledWith(
        'rec-1',
        FeishuTestStatus.PASSED,
        'batch-1',
        undefined,
        'Codex评审通过',
      );
    });

    it('should update stats for all affected batches', async () => {
      const updatedExecutions = [
        { id: 'exec-1', batch_id: 'batch-1' },
        { id: 'exec-2', batch_id: 'batch-2' },
      ] as TestExecution[];
      mockExecutionRepository.batchUpdateReview.mockResolvedValue(updatedExecutions);
      mockExecutionRepository.findByBatchIdLite.mockResolvedValue([
        { execution_status: 'completed', review_status: 'passed' },
      ] as unknown as TestExecution[]);
      mockBatchRepository.updateStats.mockResolvedValue(undefined);

      await service.batchUpdateReview(['exec-1', 'exec-2'], {
        reviewStatus: ReviewStatus.PASSED,
      });

      // Two distinct batches should each have their stats updated
      expect(batchRepository.updateStats).toHaveBeenCalledTimes(2);
    });

    it('should not write back pending batch reviews to Feishu', async () => {
      const updatedExecutions = [
        { id: 'exec-1', batch_id: 'batch-1', case_id: 'rec-1' },
      ] as TestExecution[];
      mockExecutionRepository.batchUpdateReview.mockResolvedValue(updatedExecutions);
      mockExecutionRepository.findByBatchIdLite.mockResolvedValue([
        { execution_status: 'completed', review_status: 'pending' },
      ] as unknown as TestExecution[]);
      mockBatchRepository.updateStats.mockResolvedValue(undefined);

      await service.batchUpdateReview(['exec-1'], {
        reviewStatus: ReviewStatus.PENDING,
      });

      expect(writeBackService.writeBackResult).not.toHaveBeenCalled();
    });
  });
});

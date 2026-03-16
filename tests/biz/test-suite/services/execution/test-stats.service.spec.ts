import { Test, TestingModule } from '@nestjs/testing';
import { TestStatsService } from '@biz/test-suite/services/execution/test-stats.service';
import { TestExecutionRepository } from '@biz/test-suite/repositories/test-execution.repository';
import { TestBatchRepository } from '@biz/test-suite/repositories/test-batch.repository';
import { ConversationSnapshotRepository } from '@biz/test-suite/repositories/conversation-snapshot.repository';
import {
  ExecutionStatus,
  ReviewStatus,
  TestType,
  ConversationSourceStatus,
} from '@biz/test-suite/enums/test.enum';
import { TestExecution } from '@biz/test-suite/entities/test-execution.entity';

describe('TestStatsService', () => {
  let service: TestStatsService;
  let executionRepository: jest.Mocked<TestExecutionRepository>;
  let batchRepository: jest.Mocked<TestBatchRepository>;
  let conversationSnapshotRepository: jest.Mocked<ConversationSnapshotRepository>;

  const mockExecutionRepository = {
    findByBatchIdLite: jest.fn(),
  };

  const mockBatchRepository = {
    findById: jest.fn(),
  };

  const mockConversationSnapshotRepository = {
    countByBatchIdGroupByStatus: jest.fn(),
    findByBatchId: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestStatsService,
        { provide: TestExecutionRepository, useValue: mockExecutionRepository },
        { provide: TestBatchRepository, useValue: mockBatchRepository },
        { provide: ConversationSnapshotRepository, useValue: mockConversationSnapshotRepository },
      ],
    }).compile();

    service = module.get<TestStatsService>(TestStatsService);
    executionRepository = module.get(TestExecutionRepository);
    batchRepository = module.get(TestBatchRepository);
    conversationSnapshotRepository = module.get(ConversationSnapshotRepository);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========== calculateBatchStats ==========

  describe('calculateBatchStats', () => {
    it('should use scenario stats for scenario batch type', async () => {
      mockBatchRepository.findById.mockResolvedValue({ test_type: TestType.SCENARIO });
      mockExecutionRepository.findByBatchIdLite.mockResolvedValue([]);

      const result = await service.calculateBatchStats('batch-1');

      expect(batchRepository.findById).toHaveBeenCalledWith('batch-1');
      expect(executionRepository.findByBatchIdLite).toHaveBeenCalledWith('batch-1');
      expect(result.totalCases).toBe(0);
    });

    it('should use scenario stats when batch type is null/undefined', async () => {
      mockBatchRepository.findById.mockResolvedValue(null);
      mockExecutionRepository.findByBatchIdLite.mockResolvedValue([]);

      await service.calculateBatchStats('batch-1');

      expect(executionRepository.findByBatchIdLite).toHaveBeenCalled();
      expect(conversationSnapshotRepository.countByBatchIdGroupByStatus).not.toHaveBeenCalled();
    });

    it('should use conversation stats for conversation batch type', async () => {
      mockBatchRepository.findById.mockResolvedValue({ test_type: TestType.CONVERSATION });
      mockConversationSnapshotRepository.countByBatchIdGroupByStatus.mockResolvedValue({
        total: 10,
        completed: 7,
        failed: 1,
        pending: 2,
        running: 0,
      });
      mockConversationSnapshotRepository.findByBatchId.mockResolvedValue([
        {
          status: ConversationSourceStatus.COMPLETED,
          avg_similarity_score: 80,
        },
        {
          status: ConversationSourceStatus.COMPLETED,
          avg_similarity_score: 50,
        },
        {
          status: ConversationSourceStatus.PENDING,
          avg_similarity_score: null,
        },
      ]);

      const result = await service.calculateBatchStats('batch-conv');

      expect(conversationSnapshotRepository.countByBatchIdGroupByStatus).toHaveBeenCalledWith(
        'batch-conv',
      );
      expect(result.totalCases).toBe(10);
      expect(result.executedCount).toBe(8); // completed + failed
      expect(result.passedCount).toBe(1); // score >= 60
      expect(result.failedCount).toBe(1); // score < 60
      expect(result.pendingReviewCount).toBe(2); // pending + running
    });

    it('should calculate average similarity score for conversation batch', async () => {
      mockBatchRepository.findById.mockResolvedValue({ test_type: TestType.CONVERSATION });
      mockConversationSnapshotRepository.countByBatchIdGroupByStatus.mockResolvedValue({
        total: 2,
        completed: 2,
        failed: 0,
        pending: 0,
        running: 0,
      });
      mockConversationSnapshotRepository.findByBatchId.mockResolvedValue([
        {
          status: ConversationSourceStatus.COMPLETED,
          avg_similarity_score: 70,
        },
        {
          status: ConversationSourceStatus.COMPLETED,
          avg_similarity_score: 90,
        },
      ]);

      const result = await service.calculateBatchStats('batch-conv');

      expect(result.passRate).toBe(80); // (70 + 90) / 2
    });
  });

  // ========== computeStats ==========

  describe('computeStats', () => {
    it('should return zero stats for empty executions array', () => {
      const result = service.computeStats([]);

      expect(result).toEqual({
        totalCases: 0,
        executedCount: 0,
        passedCount: 0,
        failedCount: 0,
        pendingReviewCount: 0,
        passRate: null,
        avgDurationMs: null,
        avgTokenUsage: null,
      });
    });

    it('should correctly count executed, passed, and failed cases', () => {
      const executions = [
        {
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.PASSED,
          duration_ms: 1000,
          token_usage: { totalTokens: 100 },
        },
        {
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.FAILED,
          duration_ms: 2000,
          token_usage: { totalTokens: 200 },
        },
        {
          execution_status: ExecutionStatus.PENDING,
          review_status: ReviewStatus.PENDING,
          duration_ms: null,
          token_usage: null,
        },
      ] as unknown as TestExecution[];

      const result = service.computeStats(executions);

      expect(result.totalCases).toBe(3);
      expect(result.executedCount).toBe(2);
      expect(result.passedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.pendingReviewCount).toBe(1);
    });

    it('should calculate pass rate as percentage of total cases', () => {
      const executions = [
        {
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.PASSED,
          duration_ms: 1000,
          token_usage: null,
        },
        {
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.PASSED,
          duration_ms: 2000,
          token_usage: null,
        },
        {
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.FAILED,
          duration_ms: 3000,
          token_usage: null,
        },
        {
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.PENDING,
          duration_ms: 4000,
          token_usage: null,
        },
      ] as unknown as TestExecution[];

      const result = service.computeStats(executions);

      expect(result.passRate).toBe(50); // 2 passed / 4 total * 100
    });

    it('should calculate average duration for successful executions', () => {
      const executions = [
        {
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.PASSED,
          duration_ms: 1000,
          token_usage: null,
        },
        {
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.PENDING,
          duration_ms: 3000,
          token_usage: null,
        },
        {
          execution_status: ExecutionStatus.FAILURE,
          review_status: ReviewStatus.FAILED,
          duration_ms: 500,
          token_usage: null,
        },
      ] as unknown as TestExecution[];

      const result = service.computeStats(executions);

      expect(result.avgDurationMs).toBe(2000); // only SUCCESS ones: (1000 + 3000) / 2
    });

    it('should calculate average token usage', () => {
      const executions = [
        {
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.PASSED,
          duration_ms: 1000,
          token_usage: { totalTokens: 100 },
        },
        {
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.PENDING,
          duration_ms: 2000,
          token_usage: { totalTokens: 300 },
        },
      ] as unknown as TestExecution[];

      const result = service.computeStats(executions);

      expect(result.avgTokenUsage).toBe(200);
    });

    it('should return null avgDurationMs when no successful executions', () => {
      const executions = [
        {
          execution_status: ExecutionStatus.FAILURE,
          review_status: ReviewStatus.FAILED,
          duration_ms: null,
          token_usage: null,
        },
      ] as unknown as TestExecution[];

      const result = service.computeStats(executions);

      expect(result.avgDurationMs).toBeNull();
    });

    it('should return null avgTokenUsage when no executions have token data', () => {
      const executions = [
        {
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.PASSED,
          duration_ms: 1000,
          token_usage: null,
        },
      ] as unknown as TestExecution[];

      const result = service.computeStats(executions);

      expect(result.avgTokenUsage).toBeNull();
    });
  });

  // ========== calculateCategoryStats ==========

  describe('calculateCategoryStats', () => {
    it('should delegate to executionRepository and compute stats', async () => {
      const mockExecutions = [
        {
          category: 'cat-a',
          review_status: ReviewStatus.PASSED,
          execution_status: ExecutionStatus.SUCCESS,
        },
        {
          category: 'cat-a',
          review_status: ReviewStatus.FAILED,
          execution_status: ExecutionStatus.SUCCESS,
        },
        {
          category: 'cat-b',
          review_status: ReviewStatus.PASSED,
          execution_status: ExecutionStatus.SUCCESS,
        },
      ];
      mockExecutionRepository.findByBatchIdLite.mockResolvedValue(mockExecutions);

      const result = await service.calculateCategoryStats('batch-1');

      expect(executionRepository.findByBatchIdLite).toHaveBeenCalledWith('batch-1');
      expect(result).toHaveLength(2);

      const catA = result.find((r) => r.category === 'cat-a');
      expect(catA).toEqual({ category: 'cat-a', total: 2, passed: 1, failed: 1 });

      const catB = result.find((r) => r.category === 'cat-b');
      expect(catB).toEqual({ category: 'cat-b', total: 1, passed: 1, failed: 0 });
    });
  });

  // ========== computeCategoryStats ==========

  describe('computeCategoryStats', () => {
    it('should return empty array for empty input', () => {
      const result = service.computeCategoryStats([]);
      expect(result).toHaveLength(0);
    });

    it('should group executions by category', () => {
      const executions = [
        {
          category: 'FAQ',
          review_status: ReviewStatus.PASSED,
          execution_status: ExecutionStatus.SUCCESS,
        },
        {
          category: 'FAQ',
          review_status: ReviewStatus.PASSED,
          execution_status: ExecutionStatus.SUCCESS,
        },
        {
          category: 'Booking',
          review_status: ReviewStatus.FAILED,
          execution_status: ExecutionStatus.SUCCESS,
        },
      ] as unknown as TestExecution[];

      const result = service.computeCategoryStats(executions);

      expect(result).toHaveLength(2);
    });

    it('should use 未分类 for executions without category', () => {
      const executions = [
        {
          category: null,
          review_status: ReviewStatus.PENDING,
          execution_status: ExecutionStatus.PENDING,
        },
        {
          category: undefined,
          review_status: ReviewStatus.PASSED,
          execution_status: ExecutionStatus.SUCCESS,
        },
      ] as unknown as TestExecution[];

      const result = service.computeCategoryStats(executions);

      expect(result).toHaveLength(1);
      expect(result[0].category).toBe('未分类');
      expect(result[0].total).toBe(2);
    });
  });

  // ========== calculateFailureReasonStats ==========

  describe('calculateFailureReasonStats', () => {
    it('should query only FAILED executions', async () => {
      mockExecutionRepository.findByBatchIdLite.mockResolvedValue([]);

      await service.calculateFailureReasonStats('batch-1');

      expect(executionRepository.findByBatchIdLite).toHaveBeenCalledWith('batch-1', {
        reviewStatus: ReviewStatus.FAILED,
      });
    });
  });

  // ========== computeFailureReasonStats ==========

  describe('computeFailureReasonStats', () => {
    it('should return empty array for empty input', () => {
      const result = service.computeFailureReasonStats([]);
      expect(result).toHaveLength(0);
    });

    it('should count failure reasons and calculate percentages', () => {
      const executions = [
        { failure_reason: 'wrong_answer', review_status: ReviewStatus.FAILED },
        { failure_reason: 'wrong_answer', review_status: ReviewStatus.FAILED },
        { failure_reason: 'incomplete', review_status: ReviewStatus.FAILED },
      ] as unknown as TestExecution[];

      const result = service.computeFailureReasonStats(executions);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ reason: 'wrong_answer', count: 2, percentage: 67 });
      expect(result[1]).toEqual({ reason: 'incomplete', count: 1, percentage: 33 });
    });

    it('should sort results by count descending', () => {
      const executions = [
        { failure_reason: 'rare', review_status: ReviewStatus.FAILED },
        { failure_reason: 'common', review_status: ReviewStatus.FAILED },
        { failure_reason: 'common', review_status: ReviewStatus.FAILED },
        { failure_reason: 'common', review_status: ReviewStatus.FAILED },
      ] as unknown as TestExecution[];

      const result = service.computeFailureReasonStats(executions);

      expect(result[0].reason).toBe('common');
      expect(result[1].reason).toBe('rare');
    });

    it('should use other for executions without failure_reason', () => {
      const executions = [
        { failure_reason: null, review_status: ReviewStatus.FAILED },
        { failure_reason: undefined, review_status: ReviewStatus.FAILED },
      ] as unknown as TestExecution[];

      const result = service.computeFailureReasonStats(executions);

      expect(result).toHaveLength(1);
      expect(result[0].reason).toBe('other');
      expect(result[0].count).toBe(2);
      expect(result[0].percentage).toBe(100);
    });
  });
});

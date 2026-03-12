import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { TestSuiteController } from './test-suite.controller';
import { TestSuiteService } from './test-suite.service';
import { ExecutionStatus, BatchSource, ReviewStatus, TestType } from './enums/test.enum';

describe('TestSuiteController', () => {
  let controller: TestSuiteController;
  let testService: TestSuiteService;

  const mockTestSuiteService = {
    executeTest: jest.fn(),
    executeTestStream: jest.fn(),
    executeTestStreamWithMeta: jest.fn(),
    convertVercelAIToTestRequest: jest.fn(),
    executeBatch: jest.fn(),
    createBatch: jest.fn(),
    importFromFeishu: jest.fn(),
    quickCreateBatch: jest.fn(),
    getBatches: jest.fn(),
    getBatch: jest.fn(),
    getBatchStats: jest.fn(),
    getBatchProgress: jest.fn(),
    cancelBatch: jest.fn(),
    getCategoryStats: jest.fn(),
    getFailureReasonStats: jest.fn(),
    getBatchExecutionsForList: jest.fn(),
    getExecutions: jest.fn(),
    getExecution: jest.fn(),
    updateReview: jest.fn(),
    batchUpdateReview: jest.fn(),
    writeBackToFeishu: jest.fn(),
    batchWriteBackToFeishu: jest.fn(),
    getQueueStatus: jest.fn(),
    cleanFailedJobs: jest.fn(),
    submitFeedback: jest.fn(),
    getConversationSources: jest.fn(),
    getConversationTurns: jest.fn(),
    executeConversation: jest.fn(),
    executeConversationBatch: jest.fn(),
    updateTurnReview: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TestSuiteController],
      providers: [
        {
          provide: TestSuiteService,
          useValue: mockTestSuiteService,
        },
      ],
    }).compile();

    controller = module.get<TestSuiteController>(TestSuiteController);
    testService = module.get<TestSuiteService>(TestSuiteService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('testChat', () => {
    it('should execute test and return wrapped result', async () => {
      const request = { message: 'Test question', conversationId: 'conv-1' } as any;
      const mockResult = { response: 'Test answer', status: ExecutionStatus.SUCCESS };

      mockTestSuiteService.executeTest.mockResolvedValue(mockResult);

      const result = await controller.testChat(request);

      expect(testService.executeTest).toHaveBeenCalledWith(request);
      expect(result).toEqual({ success: true, data: mockResult });
    });

    it('should propagate errors from testService', async () => {
      const request = { message: 'Error question' } as any;
      mockTestSuiteService.executeTest.mockRejectedValue(new Error('Agent error'));

      await expect(controller.testChat(request)).rejects.toThrow('Agent error');
    });
  });

  describe('batchTest', () => {
    it('should execute batch test without batchName', async () => {
      const request = {
        cases: [{ message: 'Q1' }, { message: 'Q2' }],
        parallel: true,
      } as any;
      const mockResults = [
        { status: ExecutionStatus.SUCCESS },
        { status: ExecutionStatus.FAILURE },
      ];

      mockTestSuiteService.executeBatch.mockResolvedValue(mockResults);

      const result = await controller.batchTest(request);

      expect(testService.createBatch).not.toHaveBeenCalled();
      expect(testService.executeBatch).toHaveBeenCalledWith(request.cases, undefined, true);
      expect(result).toEqual({
        success: true,
        data: {
          batchId: undefined,
          totalCases: 2,
          successCount: 1,
          failureCount: 1,
          results: mockResults,
        },
      });
    });

    it('should create batch and execute when batchName is provided', async () => {
      const request = {
        batchName: 'Test Batch 1',
        cases: [{ message: 'Q1' }],
        parallel: false,
      } as any;
      const mockBatch = { id: 'batch-001', name: 'Test Batch 1' };
      const mockResults = [{ status: ExecutionStatus.SUCCESS }];

      mockTestSuiteService.createBatch.mockResolvedValue(mockBatch);
      mockTestSuiteService.executeBatch.mockResolvedValue(mockResults);

      const result = await controller.batchTest(request);

      expect(testService.createBatch).toHaveBeenCalledWith({
        name: 'Test Batch 1',
        source: BatchSource.MANUAL,
      });
      expect(testService.executeBatch).toHaveBeenCalledWith(request.cases, 'batch-001', false);
      expect(result.data.batchId).toBe('batch-001');
      expect(result.data.successCount).toBe(1);
      expect(result.data.failureCount).toBe(0);
    });
  });

  describe('createBatch', () => {
    it('should create batch and return wrapped result', async () => {
      const request = { name: 'New Batch', source: BatchSource.MANUAL } as any;
      const mockBatch = { id: 'batch-new', name: 'New Batch' };

      mockTestSuiteService.createBatch.mockResolvedValue(mockBatch);

      const result = await controller.createBatch(request);

      expect(testService.createBatch).toHaveBeenCalledWith(request);
      expect(result).toEqual({ success: true, data: mockBatch });
    });
  });

  describe('importFromFeishu', () => {
    it('should import from feishu and return wrapped result', async () => {
      const request = { tableId: 'table-1', viewId: 'view-1' } as any;
      const mockResult = { importedCount: 10 };

      mockTestSuiteService.importFromFeishu.mockResolvedValue(mockResult);

      const result = await controller.importFromFeishu(request);

      expect(testService.importFromFeishu).toHaveBeenCalledWith(request);
      expect(result).toEqual({ success: true, data: mockResult });
    });
  });

  describe('quickCreateBatch', () => {
    it('should quick create batch with default scenario test type', async () => {
      const request = { batchName: 'Quick Batch', parallel: true } as any;
      const mockResult = { id: 'batch-quick' };

      mockTestSuiteService.quickCreateBatch.mockResolvedValue(mockResult);

      const result = await controller.quickCreateBatch(request);

      expect(testService.quickCreateBatch).toHaveBeenCalledWith({
        batchName: 'Quick Batch',
        parallel: true,
        testType: TestType.SCENARIO,
      });
      expect(result).toEqual({ success: true, data: mockResult });
    });

    it('should use provided testType when specified', async () => {
      const request = {
        batchName: 'Conversation Batch',
        parallel: false,
        testType: TestType.CONVERSATION,
      } as any;
      mockTestSuiteService.quickCreateBatch.mockResolvedValue({ id: 'batch-conv' });

      await controller.quickCreateBatch(request);

      expect(testService.quickCreateBatch).toHaveBeenCalledWith({
        batchName: 'Conversation Batch',
        parallel: false,
        testType: TestType.CONVERSATION,
      });
    });
  });

  describe('getBatches', () => {
    it('should return batches with default pagination', async () => {
      const mockResult = { data: [{ id: 'batch-1' }], total: 1 };

      mockTestSuiteService.getBatches.mockResolvedValue(mockResult);

      const result = await controller.getBatches();

      expect(testService.getBatches).toHaveBeenCalledWith(20, 0, undefined);
      expect(result).toEqual({ success: true, data: mockResult.data, total: mockResult.total });
    });

    it('should pass custom limit, offset and testType', async () => {
      const mockResult = { data: [], total: 0 };
      mockTestSuiteService.getBatches.mockResolvedValue(mockResult);

      await controller.getBatches(5, 10, TestType.SCENARIO);

      expect(testService.getBatches).toHaveBeenCalledWith(5, 10, TestType.SCENARIO);
    });
  });

  describe('getBatch', () => {
    it('should return batch when found', async () => {
      const mockBatch = { id: 'batch-1', name: 'My Batch' };
      mockTestSuiteService.getBatch.mockResolvedValue(mockBatch);

      const result = await controller.getBatch('batch-1');

      expect(testService.getBatch).toHaveBeenCalledWith('batch-1');
      expect(result).toEqual({ success: true, data: mockBatch });
    });

    it('should throw 404 when batch not found', async () => {
      mockTestSuiteService.getBatch.mockResolvedValue(null);

      await expect(controller.getBatch('nonexistent')).rejects.toThrow(
        new HttpException('批次不存在', HttpStatus.NOT_FOUND),
      );
    });
  });

  describe('getBatchStats', () => {
    it('should return batch stats', async () => {
      const mockStats = { successCount: 8, failureCount: 2, total: 10 };
      mockTestSuiteService.getBatchStats.mockResolvedValue(mockStats);

      const result = await controller.getBatchStats('batch-1');

      expect(testService.getBatchStats).toHaveBeenCalledWith('batch-1');
      expect(result).toEqual({ success: true, data: mockStats });
    });
  });

  describe('getBatchProgress', () => {
    it('should return batch progress', async () => {
      const mockProgress = { completed: 5, total: 10, percentage: 50 };
      mockTestSuiteService.getBatchProgress.mockResolvedValue(mockProgress);

      const result = await controller.getBatchProgress('batch-1');

      expect(testService.getBatchProgress).toHaveBeenCalledWith('batch-1');
      expect(result).toEqual({ success: true, data: mockProgress });
    });
  });

  describe('cancelBatch', () => {
    it('should cancel batch and return result', async () => {
      const mockResult = { cancelled: true };
      mockTestSuiteService.cancelBatch.mockResolvedValue(mockResult);

      const result = await controller.cancelBatch('batch-1');

      expect(testService.cancelBatch).toHaveBeenCalledWith('batch-1');
      expect(result).toEqual({ success: true, data: mockResult });
    });
  });

  describe('getCategoryStats', () => {
    it('should return category statistics', async () => {
      const mockStats = [{ category: 'A', count: 5 }];
      mockTestSuiteService.getCategoryStats.mockResolvedValue(mockStats);

      const result = await controller.getCategoryStats('batch-1');

      expect(testService.getCategoryStats).toHaveBeenCalledWith('batch-1');
      expect(result).toEqual({ success: true, data: mockStats });
    });
  });

  describe('getFailureReasonStats', () => {
    it('should return failure reason statistics', async () => {
      const mockStats = [{ reason: 'wrong_answer', count: 3 }];
      mockTestSuiteService.getFailureReasonStats.mockResolvedValue(mockStats);

      const result = await controller.getFailureReasonStats('batch-1');

      expect(testService.getFailureReasonStats).toHaveBeenCalledWith('batch-1');
      expect(result).toEqual({ success: true, data: mockStats });
    });
  });

  describe('getBatchExecutions', () => {
    it('should return batch executions with filters', async () => {
      const mockExecutions = [{ id: 'exec-1', status: ExecutionStatus.SUCCESS }];
      mockTestSuiteService.getBatchExecutionsForList.mockResolvedValue(mockExecutions);

      const result = await controller.getBatchExecutions(
        'batch-1',
        ReviewStatus.PENDING,
        ExecutionStatus.SUCCESS,
        'category-A',
      );

      expect(testService.getBatchExecutionsForList).toHaveBeenCalledWith('batch-1', {
        reviewStatus: ReviewStatus.PENDING,
        executionStatus: ExecutionStatus.SUCCESS,
        category: 'category-A',
      });
      expect(result).toEqual({ success: true, data: mockExecutions });
    });

    it('should call with undefined filters when not provided', async () => {
      mockTestSuiteService.getBatchExecutionsForList.mockResolvedValue([]);

      await controller.getBatchExecutions('batch-1');

      expect(testService.getBatchExecutionsForList).toHaveBeenCalledWith('batch-1', {
        reviewStatus: undefined,
        executionStatus: undefined,
        category: undefined,
      });
    });
  });

  describe('getExecutions', () => {
    it('should return executions with default pagination', async () => {
      const mockExecutions = [{ id: 'exec-1' }];
      mockTestSuiteService.getExecutions.mockResolvedValue(mockExecutions);

      const result = await controller.getExecutions();

      expect(testService.getExecutions).toHaveBeenCalledWith(50, 0);
      expect(result).toEqual({ success: true, data: mockExecutions });
    });

    it('should pass custom limit and offset', async () => {
      mockTestSuiteService.getExecutions.mockResolvedValue([]);

      await controller.getExecutions(10, 20);

      expect(testService.getExecutions).toHaveBeenCalledWith(10, 20);
    });
  });

  describe('getExecution', () => {
    it('should return execution when found', async () => {
      const mockExecution = { id: 'exec-1', status: ExecutionStatus.SUCCESS };
      mockTestSuiteService.getExecution.mockResolvedValue(mockExecution);

      const result = await controller.getExecution('exec-1');

      expect(testService.getExecution).toHaveBeenCalledWith('exec-1');
      expect(result).toEqual({ success: true, data: mockExecution });
    });

    it('should throw 404 when execution not found', async () => {
      mockTestSuiteService.getExecution.mockResolvedValue(null);

      await expect(controller.getExecution('nonexistent')).rejects.toThrow(
        new HttpException('执行记录不存在', HttpStatus.NOT_FOUND),
      );
    });
  });

  describe('updateReview', () => {
    it('should update review status and return result', async () => {
      const review = { reviewStatus: ReviewStatus.PASSED, comment: 'Good answer' } as any;
      const mockResult = { id: 'exec-1', reviewStatus: ReviewStatus.PASSED };
      mockTestSuiteService.updateReview.mockResolvedValue(mockResult);

      const result = await controller.updateReview('exec-1', review);

      expect(testService.updateReview).toHaveBeenCalledWith('exec-1', review);
      expect(result).toEqual({ success: true, data: mockResult });
    });
  });

  describe('batchUpdateReview', () => {
    it('should batch update reviews and return count', async () => {
      const body = {
        executionIds: ['exec-1', 'exec-2'],
        review: { reviewStatus: ReviewStatus.PASSED } as any,
      };
      mockTestSuiteService.batchUpdateReview.mockResolvedValue(2);

      const result = await controller.batchUpdateReview(body);

      expect(testService.batchUpdateReview).toHaveBeenCalledWith(['exec-1', 'exec-2'], body.review);
      expect(result).toEqual({ success: true, data: { updatedCount: 2 } });
    });
  });

  describe('writeBackToFeishu', () => {
    it('should write back single execution to feishu', async () => {
      const request = { executionId: 'exec-1', testStatus: '通过' as any } as any;
      const mockResult = { success: true, rowId: 'row-1' };
      mockTestSuiteService.writeBackToFeishu.mockResolvedValue(mockResult);

      const result = await controller.writeBackToFeishu('exec-1', request);

      expect(testService.writeBackToFeishu).toHaveBeenCalledWith('exec-1', '通过', undefined);
      expect(result).toEqual({ success: true, data: mockResult });
    });

    it('should throw 400 when executionId in body does not match path param', async () => {
      const request = { executionId: 'different-id', testStatus: '通过' as any } as any;

      await expect(controller.writeBackToFeishu('exec-1', request)).rejects.toThrow(
        new HttpException('执行记录ID不匹配', HttpStatus.BAD_REQUEST),
      );
    });

    it('should proceed when executionId is not in body', async () => {
      const request = { testStatus: '通过' as any, errorReason: 'None' } as any;
      mockTestSuiteService.writeBackToFeishu.mockResolvedValue({ success: true });

      await controller.writeBackToFeishu('exec-1', request);

      expect(testService.writeBackToFeishu).toHaveBeenCalledWith('exec-1', '通过', 'None');
    });
  });

  describe('batchWriteBackToFeishu', () => {
    it('should batch write back and return summary', async () => {
      const body = {
        items: [
          { executionId: 'exec-1', testStatus: '通过' as any },
          { executionId: 'exec-2', testStatus: '失败' as any },
        ],
      };
      const mockResults = { success: 1, failed: 1, errors: ['Error in exec-2'] };
      mockTestSuiteService.batchWriteBackToFeishu.mockResolvedValue(mockResults);

      const result = await controller.batchWriteBackToFeishu(body);

      expect(testService.batchWriteBackToFeishu).toHaveBeenCalledWith(body.items);
      expect(result).toEqual({
        success: true,
        data: {
          totalCount: 2,
          successCount: 1,
          failureCount: 1,
          errors: ['Error in exec-2'],
        },
      });
    });
  });

  describe('getQueueStatus', () => {
    it('should return queue status', async () => {
      const mockStatus = { waiting: 5, active: 2, completed: 100 };
      mockTestSuiteService.getQueueStatus.mockResolvedValue(mockStatus);

      const result = await controller.getQueueStatus();

      expect(testService.getQueueStatus).toHaveBeenCalled();
      expect(result).toEqual({ success: true, data: mockStatus });
    });
  });

  describe('cleanFailedJobs', () => {
    it('should clean failed jobs and return count', async () => {
      mockTestSuiteService.cleanFailedJobs.mockResolvedValue(5);

      const result = await controller.cleanFailedJobs();

      expect(testService.cleanFailedJobs).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        data: { removedCount: 5, message: '已清理 5 个失败任务' },
      });
    });
  });

  describe('submitFeedback', () => {
    it('should submit feedback and return result', async () => {
      const request = { executionId: 'exec-1', feedbackType: 'badcase', comment: 'Wrong' } as any;
      const mockResult = { id: 'feedback-1' };
      mockTestSuiteService.submitFeedback.mockResolvedValue(mockResult);

      const result = await controller.submitFeedback(request);

      expect(testService.submitFeedback).toHaveBeenCalledWith(request);
      expect(result).toEqual({ success: true, data: mockResult });
    });
  });

  describe('syncConversationTests', () => {
    it('should throw NOT_IMPLEMENTED error', async () => {
      await expect(controller.syncConversationTests({} as any)).rejects.toThrow(
        new HttpException('回归验证同步功能即将上线', HttpStatus.NOT_IMPLEMENTED),
      );
    });
  });

  describe('getConversationSources', () => {
    it('should return conversation sources with default pagination', async () => {
      const query = { batchId: 'batch-1' } as any;
      const mockResult = [{ id: 'source-1' }];
      mockTestSuiteService.getConversationSources.mockResolvedValue(mockResult);

      const result = await controller.getConversationSources(query);

      expect(testService.getConversationSources).toHaveBeenCalledWith('batch-1', 1, 20, undefined);
      expect(result).toEqual({ success: true, data: mockResult });
    });
  });

  describe('getConversationTurns', () => {
    it('should return conversation turns for sourceId', async () => {
      const mockTurns = [{ turn: 1, question: 'Q1', answer: 'A1' }];
      mockTestSuiteService.getConversationTurns.mockResolvedValue(mockTurns);

      const result = await controller.getConversationTurns('source-1');

      expect(testService.getConversationTurns).toHaveBeenCalledWith('source-1');
      expect(result).toEqual({ success: true, data: mockTurns });
    });
  });

  describe('executeConversation', () => {
    it('should execute single conversation validation', async () => {
      const request = { forceRerun: false } as any;
      const mockResult = { sourceId: 'source-1', status: 'completed' };
      mockTestSuiteService.executeConversation.mockResolvedValue(mockResult);

      const result = await controller.executeConversation('source-1', request);

      expect(testService.executeConversation).toHaveBeenCalledWith('source-1', false);
      expect(result).toEqual({ success: true, data: mockResult });
    });
  });

  describe('executeConversationBatch', () => {
    it('should execute batch conversation validation', async () => {
      const request = { forceRerun: true } as any;
      const mockResult = { batchId: 'batch-1', processed: 5 };
      mockTestSuiteService.executeConversationBatch.mockResolvedValue(mockResult);

      const result = await controller.executeConversationBatch('batch-1', request);

      expect(testService.executeConversationBatch).toHaveBeenCalledWith('batch-1', true);
      expect(result).toEqual({ success: true, data: mockResult });
    });
  });

  describe('updateTurnReview', () => {
    it('should update turn review status', async () => {
      const request = { reviewStatus: ReviewStatus.PASSED, reviewComment: 'Correct' } as any;
      const mockResult = { executionId: 'exec-1', reviewStatus: ReviewStatus.PASSED };
      mockTestSuiteService.updateTurnReview.mockResolvedValue(mockResult);

      const result = await controller.updateTurnReview('exec-1', request);

      expect(testService.updateTurnReview).toHaveBeenCalledWith(
        'exec-1',
        ReviewStatus.PASSED,
        'Correct',
      );
      expect(result).toEqual({ success: true, data: mockResult });
    });
  });
});

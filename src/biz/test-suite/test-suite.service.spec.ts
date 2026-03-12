import { Test, TestingModule } from '@nestjs/testing';
import { TestSuiteService } from './test-suite.service';
import { TestExecutionService } from './services/execution/test-execution.service';
import { TestBatchService } from './services/execution/test-batch.service';
import { TestImportService } from './services/feishu/test-import.service';
import { TestWriteBackService } from './services/feishu/test-write-back.service';
import { ConversationTestService } from './services/conversation/conversation-test.service';
import { FeishuBitableSyncService } from '@core/feishu/services/feishu-bitable.service';
import { TestSuiteProcessor } from './test-suite.processor';
import {
  BatchStatus,
  ExecutionStatus,
  ReviewStatus,
  FeishuTestStatus,
  TestType,
  FeedbackType,
} from './enums/test.enum';
import { MessageRole } from '@shared/enums';
import { VercelAIChatRequestDto } from './dto/test-chat.dto';

describe('TestSuiteService', () => {
  let service: TestSuiteService;
  let executionService: jest.Mocked<TestExecutionService>;
  let batchService: jest.Mocked<TestBatchService>;
  let importService: jest.Mocked<TestImportService>;
  let writeBackService: jest.Mocked<TestWriteBackService>;
  let conversationTestService: jest.Mocked<ConversationTestService>;
  let feishuBitableService: jest.Mocked<FeishuBitableSyncService>;
  let testProcessor: jest.Mocked<TestSuiteProcessor>;

  const mockExecutionService = {
    executeTest: jest.fn(),
    executeTestStream: jest.fn(),
    executeTestStreamWithMeta: jest.fn(),
    getExecution: jest.fn(),
    getExecutions: jest.fn(),
    countCompletedExecutions: jest.fn(),
    updateExecutionByBatchAndCase: jest.fn(),
  };

  const mockBatchService = {
    createBatch: jest.fn(),
    getBatches: jest.fn(),
    getBatch: jest.fn(),
    getBatchExecutions: jest.fn(),
    getBatchExecutionsForList: jest.fn(),
    getBatchStats: jest.fn(),
    getCategoryStats: jest.fn(),
    getFailureReasonStats: jest.fn(),
    updateReview: jest.fn(),
    batchUpdateReview: jest.fn(),
    updateBatchStatus: jest.fn(),
    updateBatchStats: jest.fn(),
  };

  const mockImportService = {
    importFromFeishu: jest.fn(),
    quickCreateBatch: jest.fn(),
  };

  const mockWriteBackService = {
    writeBackToFeishu: jest.fn(),
    batchWriteBackToFeishu: jest.fn(),
  };

  const mockConversationTestService = {
    getConversationSources: jest.fn(),
    getConversationTurns: jest.fn(),
    executeConversation: jest.fn(),
    executeConversationBatch: jest.fn(),
    updateTurnReview: jest.fn(),
    getSourceBatchId: jest.fn(),
  };

  const mockFeishuBitableService = {
    writeAgentTestFeedback: jest.fn(),
  };

  const mockTestProcessor = {
    getBatchProgress: jest.fn(),
    cancelBatchJobs: jest.fn(),
    getQueueStatus: jest.fn(),
    cleanFailedJobs: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestSuiteService,
        { provide: TestExecutionService, useValue: mockExecutionService },
        { provide: TestBatchService, useValue: mockBatchService },
        { provide: TestImportService, useValue: mockImportService },
        { provide: TestWriteBackService, useValue: mockWriteBackService },
        { provide: ConversationTestService, useValue: mockConversationTestService },
        { provide: FeishuBitableSyncService, useValue: mockFeishuBitableService },
        { provide: TestSuiteProcessor, useValue: mockTestProcessor },
      ],
    }).compile();

    service = module.get<TestSuiteService>(TestSuiteService);
    executionService = module.get(TestExecutionService);
    batchService = module.get(TestBatchService);
    importService = module.get(TestImportService);
    writeBackService = module.get(TestWriteBackService);
    conversationTestService = module.get(ConversationTestService);
    feishuBitableService = module.get(FeishuBitableSyncService);
    testProcessor = module.get(TestSuiteProcessor);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========== executeTest ==========

  describe('executeTest', () => {
    it('should delegate to executionService', async () => {
      const mockResponse = {
        actualOutput: 'test output',
        status: ExecutionStatus.SUCCESS,
        request: { url: 'http://api', method: 'POST', body: null },
        response: { statusCode: 200, body: null },
        metrics: {
          durationMs: 100,
          tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        },
      };
      mockExecutionService.executeTest.mockResolvedValue(mockResponse);

      const result = await service.executeTest({ message: 'test', userId: 'user-1' });

      expect(executionService.executeTest).toHaveBeenCalledWith({
        message: 'test',
        userId: 'user-1',
      });
      expect(result).toBe(mockResponse);
    });
  });

  // ========== executeTestStream ==========

  describe('executeTestStream', () => {
    it('should delegate to executionService', async () => {
      const mockStream = {} as NodeJS.ReadableStream;
      mockExecutionService.executeTestStream.mockResolvedValue(mockStream);

      const result = await service.executeTestStream({ message: 'test', userId: 'u1' });

      expect(executionService.executeTestStream).toHaveBeenCalled();
      expect(result).toBe(mockStream);
    });
  });

  // ========== executeTestStreamWithMeta ==========

  describe('executeTestStreamWithMeta', () => {
    it('should delegate to executionService', async () => {
      const mockResult = { stream: {} as NodeJS.ReadableStream, estimatedInputTokens: 100 };
      mockExecutionService.executeTestStreamWithMeta.mockResolvedValue(mockResult);

      const result = await service.executeTestStreamWithMeta({ message: 'test', userId: 'u1' });

      expect(executionService.executeTestStreamWithMeta).toHaveBeenCalled();
      expect(result).toBe(mockResult);
    });
  });

  // ========== executeBatch ==========

  describe('executeBatch', () => {
    const makeTestResponse = (output: string) => ({
      actualOutput: output,
      status: ExecutionStatus.SUCCESS,
      request: { url: 'http://api', method: 'POST', body: null },
      response: { statusCode: 200, body: null },
      metrics: {
        durationMs: 100,
        tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
    });

    it('should execute all cases sequentially by default', async () => {
      const cases = [
        { message: 'q1', userId: 'u1' },
        { message: 'q2', userId: 'u1' },
      ];
      mockExecutionService.executeTest.mockResolvedValue(makeTestResponse('resp'));

      const results = await service.executeBatch(cases);

      expect(executionService.executeTest).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(2);
    });

    it('should update batch status when batchId is provided', async () => {
      mockExecutionService.executeTest.mockResolvedValue(makeTestResponse('resp'));
      mockBatchService.updateBatchStatus.mockResolvedValue(undefined);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);

      await service.executeBatch([{ message: 'q1', userId: 'u1' }], 'batch-1');

      expect(batchService.updateBatchStatus).toHaveBeenCalledWith('batch-1', BatchStatus.RUNNING);
      expect(batchService.updateBatchStats).toHaveBeenCalledWith('batch-1');
      expect(batchService.updateBatchStatus).toHaveBeenCalledWith('batch-1', BatchStatus.REVIEWING);
    });

    it('should execute cases in parallel batches of 5 when parallel=true', async () => {
      const cases = Array.from({ length: 6 }, (_, i) => ({
        message: `q${i}`,
        userId: 'u1',
      }));
      mockExecutionService.executeTest.mockResolvedValue(makeTestResponse('resp'));

      const results = await service.executeBatch(cases, undefined, true);

      expect(results).toHaveLength(6);
      expect(executionService.executeTest).toHaveBeenCalledTimes(6);
    });

    it('should inject batchId into each test case', async () => {
      mockExecutionService.executeTest.mockResolvedValue(makeTestResponse('resp'));
      mockBatchService.updateBatchStatus.mockResolvedValue(undefined);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);

      await service.executeBatch([{ message: 'q1', userId: 'u1' }], 'batch-123');

      expect(executionService.executeTest).toHaveBeenCalledWith(
        expect.objectContaining({ batchId: 'batch-123' }),
      );
    });
  });

  // ========== getExecution ==========

  describe('getExecution', () => {
    it('should delegate to executionService', async () => {
      const mockExec = { id: 'exec-1' } as any;
      mockExecutionService.getExecution.mockResolvedValue(mockExec);

      const result = await service.getExecution('exec-1');

      expect(executionService.getExecution).toHaveBeenCalledWith('exec-1');
      expect(result).toBe(mockExec);
    });
  });

  // ========== getExecutions ==========

  describe('getExecutions', () => {
    it('should delegate to executionService with default params', async () => {
      mockExecutionService.getExecutions.mockResolvedValue([]);

      await service.getExecutions();

      expect(executionService.getExecutions).toHaveBeenCalledWith(50, 0);
    });

    it('should pass custom limit and offset', async () => {
      mockExecutionService.getExecutions.mockResolvedValue([]);

      await service.getExecutions(10, 5);

      expect(executionService.getExecutions).toHaveBeenCalledWith(10, 5);
    });
  });

  // ========== Batch management delegation ==========

  describe('createBatch', () => {
    it('should delegate to batchService', async () => {
      const mockBatch = { id: 'batch-1' } as any;
      mockBatchService.createBatch.mockResolvedValue(mockBatch);

      const result = await service.createBatch({ name: 'Test' });

      expect(batchService.createBatch).toHaveBeenCalledWith({ name: 'Test' });
      expect(result).toBe(mockBatch);
    });
  });

  describe('getBatches', () => {
    it('should delegate to batchService', async () => {
      const mockResult = { data: [], total: 0 };
      mockBatchService.getBatches.mockResolvedValue(mockResult);

      const result = await service.getBatches(10, 0, TestType.SCENARIO);

      expect(batchService.getBatches).toHaveBeenCalledWith(10, 0, TestType.SCENARIO);
      expect(result).toBe(mockResult);
    });
  });

  describe('getBatch', () => {
    it('should delegate to batchService', async () => {
      mockBatchService.getBatch.mockResolvedValue(null);

      await service.getBatch('batch-1');

      expect(batchService.getBatch).toHaveBeenCalledWith('batch-1');
    });
  });

  describe('getBatchStats', () => {
    it('should delegate to batchService', async () => {
      const mockStats = { totalCases: 5 } as any;
      mockBatchService.getBatchStats.mockResolvedValue(mockStats);

      const result = await service.getBatchStats('batch-1');

      expect(batchService.getBatchStats).toHaveBeenCalledWith('batch-1');
      expect(result).toBe(mockStats);
    });
  });

  describe('updateReview', () => {
    it('should delegate to batchService', async () => {
      const mockExec = { id: 'exec-1' } as any;
      mockBatchService.updateReview.mockResolvedValue(mockExec);
      const review = { reviewStatus: ReviewStatus.PASSED };

      const result = await service.updateReview('exec-1', review);

      expect(batchService.updateReview).toHaveBeenCalledWith('exec-1', review);
      expect(result).toBe(mockExec);
    });
  });

  describe('batchUpdateReview', () => {
    it('should delegate to batchService', async () => {
      mockBatchService.batchUpdateReview.mockResolvedValue(3);
      const review = { reviewStatus: ReviewStatus.PASSED };

      const result = await service.batchUpdateReview(['exec-1', 'exec-2', 'exec-3'], review);

      expect(batchService.batchUpdateReview).toHaveBeenCalledWith(
        ['exec-1', 'exec-2', 'exec-3'],
        review,
      );
      expect(result).toBe(3);
    });
  });

  // ========== getBatchProgress ==========

  describe('getBatchProgress', () => {
    it('should delegate to testProcessor', async () => {
      const mockProgress = { total: 10, completed: 5, running: 3, waiting: 2 };
      mockTestProcessor.getBatchProgress.mockResolvedValue(mockProgress);

      const result = await service.getBatchProgress('batch-1');

      expect(testProcessor.getBatchProgress).toHaveBeenCalledWith('batch-1');
      expect(result).toBe(mockProgress);
    });
  });

  // ========== cancelBatch ==========

  describe('cancelBatch', () => {
    it('should cancel batch jobs and update status', async () => {
      mockTestProcessor.cancelBatchJobs.mockResolvedValue({
        waiting: 3,
        delayed: 1,
        active: 2,
      });
      mockBatchService.updateBatchStatus.mockResolvedValue(undefined);

      const result = await service.cancelBatch('batch-1');

      expect(testProcessor.cancelBatchJobs).toHaveBeenCalledWith('batch-1');
      expect(batchService.updateBatchStatus).toHaveBeenCalledWith('batch-1', BatchStatus.CANCELLED);
      expect(result.batchId).toBe('batch-1');
      expect(result.totalCancelled).toBe(6); // 3 + 1 + 2
      expect(result.cancelled).toEqual({ waiting: 3, delayed: 1, active: 2 });
    });
  });

  // ========== getQueueStatus ==========

  describe('getQueueStatus', () => {
    it('should delegate to testProcessor', async () => {
      const mockStatus = { waiting: 5, active: 2 };
      mockTestProcessor.getQueueStatus.mockResolvedValue(mockStatus);

      const result = await service.getQueueStatus();

      expect(testProcessor.getQueueStatus).toHaveBeenCalled();
      expect(result).toBe(mockStatus);
    });
  });

  // ========== cleanFailedJobs ==========

  describe('cleanFailedJobs', () => {
    it('should delegate to testProcessor', async () => {
      mockTestProcessor.cleanFailedJobs.mockResolvedValue(7);

      const result = await service.cleanFailedJobs();

      expect(testProcessor.cleanFailedJobs).toHaveBeenCalled();
      expect(result).toBe(7);
    });
  });

  // ========== importFromFeishu ==========

  describe('importFromFeishu', () => {
    it('should delegate to importService', async () => {
      const mockResult = { batchId: 'batch-1', batchName: 'Test', totalImported: 5, cases: [] };
      mockImportService.importFromFeishu.mockResolvedValue(mockResult);

      const result = await service.importFromFeishu({ appToken: 'a', tableId: 't' });

      expect(importService.importFromFeishu).toHaveBeenCalledWith({ appToken: 'a', tableId: 't' });
      expect(result).toBe(mockResult);
    });
  });

  // ========== quickCreateBatch ==========

  describe('quickCreateBatch', () => {
    it('should delegate to importService', async () => {
      const mockResult = { batchId: 'batch-1', batchName: 'Quick', totalImported: 3, cases: [] };
      mockImportService.quickCreateBatch.mockResolvedValue(mockResult);

      const result = await service.quickCreateBatch({
        batchName: 'Quick',
        testType: TestType.SCENARIO,
      });

      expect(importService.quickCreateBatch).toHaveBeenCalledWith({
        batchName: 'Quick',
        testType: TestType.SCENARIO,
      });
      expect(result).toBe(mockResult);
    });
  });

  // ========== writeBackToFeishu ==========

  describe('writeBackToFeishu', () => {
    it('should delegate to writeBackService', async () => {
      mockWriteBackService.writeBackToFeishu.mockResolvedValue({ success: true });

      const result = await service.writeBackToFeishu('exec-1', FeishuTestStatus.PASSED);

      expect(writeBackService.writeBackToFeishu).toHaveBeenCalledWith(
        'exec-1',
        FeishuTestStatus.PASSED,
        undefined,
      );
      expect(result.success).toBe(true);
    });
  });

  // ========== batchWriteBackToFeishu ==========

  describe('batchWriteBackToFeishu', () => {
    it('should delegate to writeBackService', async () => {
      mockWriteBackService.batchWriteBackToFeishu.mockResolvedValue({
        success: 2,
        failed: 0,
        errors: [],
      });

      const items = [
        { executionId: 'exec-1', testStatus: FeishuTestStatus.PASSED },
        { executionId: 'exec-2', testStatus: FeishuTestStatus.FAILED },
      ];

      const result = await service.batchWriteBackToFeishu(items);

      expect(writeBackService.batchWriteBackToFeishu).toHaveBeenCalledWith(items);
      expect(result.success).toBe(2);
    });
  });

  // ========== submitFeedback ==========

  describe('submitFeedback', () => {
    it('should write feedback to feishu and return result', async () => {
      mockFeishuBitableService.writeAgentTestFeedback.mockResolvedValue({
        success: true,
        recordId: 'rec-new-1',
      });

      const result = await service.submitFeedback({
        type: FeedbackType.BADCASE,
        chatHistory: 'user: 你好\nassistant: 好的',
        userMessage: '你好',
        errorType: '回答错误',
        remark: 'The answer was wrong',
        chatId: 'chat-123',
      });

      expect(feishuBitableService.writeAgentTestFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          type: FeedbackType.BADCASE,
          chatHistory: 'user: 你好\nassistant: 好的',
          userMessage: '你好',
        }),
      );
      expect(result.recordId).toBe('rec-new-1');
      expect(result.type).toBe(FeedbackType.BADCASE);
    });

    it('should throw error when feishu write fails', async () => {
      mockFeishuBitableService.writeAgentTestFeedback.mockResolvedValue({
        success: false,
        error: 'Permission denied',
      });

      await expect(
        service.submitFeedback({
          type: FeedbackType.GOODCASE,
          chatHistory: 'history',
        }),
      ).rejects.toThrow('Permission denied');
    });

    it('should throw generic error when feishu write fails without error message', async () => {
      mockFeishuBitableService.writeAgentTestFeedback.mockResolvedValue({ success: false });

      await expect(
        service.submitFeedback({ type: FeedbackType.BADCASE, chatHistory: 'h' }),
      ).rejects.toThrow('写入飞书表格失败');
    });
  });

  // ========== convertVercelAIToTestRequest ==========

  describe('convertVercelAIToTestRequest', () => {
    const makeRequest = (overrides: Partial<VercelAIChatRequestDto> = {}): VercelAIChatRequestDto =>
      ({
        messages: [
          {
            id: 'msg-1',
            role: MessageRole.USER,
            parts: [{ type: 'text', text: '你好' }],
          },
        ],
        ...overrides,
      }) as VercelAIChatRequestDto;

    it('should extract the latest user message as test input', () => {
      const request = makeRequest({
        messages: [
          { id: 'msg-1', role: MessageRole.USER, parts: [{ type: 'text', text: '你好' }] },
          {
            id: 'msg-2',
            role: MessageRole.ASSISTANT,
            parts: [{ type: 'text', text: '有什么可以帮您？' }],
          },
          { id: 'msg-3', role: MessageRole.USER, parts: [{ type: 'text', text: '薪资多少？' }] },
        ] as VercelAIChatRequestDto['messages'],
        userId: 'user-1',
      });

      const result = service.convertVercelAIToTestRequest(request);

      expect(result.messageText).toBe('薪资多少？');
      expect(result.testRequest.message).toBe('薪资多少？');
    });

    it('should include all messages except the last as history', () => {
      const request = makeRequest({
        messages: [
          { id: 'msg-1', role: MessageRole.USER, parts: [{ type: 'text', text: '你好' }] },
          { id: 'msg-2', role: MessageRole.ASSISTANT, parts: [{ type: 'text', text: '好的' }] },
          { id: 'msg-3', role: MessageRole.USER, parts: [{ type: 'text', text: '继续' }] },
        ] as VercelAIChatRequestDto['messages'],
      });

      const result = service.convertVercelAIToTestRequest(request);

      expect(result.testRequest.history).toHaveLength(2);
    });

    it('should set default scenario to candidate-consultation', () => {
      const result = service.convertVercelAIToTestRequest(makeRequest());

      expect(result.testRequest.scenario).toBe('candidate-consultation');
    });

    it('should use provided scenario when specified', () => {
      const result = service.convertVercelAIToTestRequest(
        makeRequest({ scenario: 'custom-scenario' }),
      );

      expect(result.testRequest.scenario).toBe('custom-scenario');
    });

    it('should set skipHistoryTrim to true', () => {
      const result = service.convertVercelAIToTestRequest(makeRequest());

      expect(result.testRequest.skipHistoryTrim).toBe(true);
    });

    it('should set saveExecution to false by default', () => {
      const result = service.convertVercelAIToTestRequest(makeRequest());

      expect(result.testRequest.saveExecution).toBe(false);
    });

    it('should concatenate multi-part text messages', () => {
      const request = makeRequest({
        messages: [
          {
            id: 'msg-1',
            role: MessageRole.USER,
            parts: [
              { type: 'text', text: 'Hello ' },
              { type: 'text', text: 'World' },
            ],
          },
        ] as VercelAIChatRequestDto['messages'],
      });

      const result = service.convertVercelAIToTestRequest(request);

      expect(result.messageText).toBe('Hello World');
    });

    it('should return empty messageText when parts are empty', () => {
      const request = makeRequest({
        messages: [
          { id: 'msg-1', role: MessageRole.USER, parts: [] },
        ] as VercelAIChatRequestDto['messages'],
      });

      const result = service.convertVercelAIToTestRequest(request);

      expect(result.messageText).toBe('');
    });
  });

  // ========== getConversationSources ==========

  describe('getConversationSources', () => {
    it('should delegate to conversationTestService', async () => {
      const mockResult = { sources: [], total: 0, page: 1, pageSize: 20 };
      mockConversationTestService.getConversationSources.mockResolvedValue(mockResult);

      const result = await service.getConversationSources('batch-1', 1, 20);

      expect(conversationTestService.getConversationSources).toHaveBeenCalledWith(
        'batch-1',
        1,
        20,
        undefined,
      );
      expect(result).toBe(mockResult);
    });
  });

  // ========== getConversationTurns ==========

  describe('getConversationTurns', () => {
    it('should delegate to conversationTestService', async () => {
      const mockResult = { turns: [], conversationInfo: {} } as any;
      mockConversationTestService.getConversationTurns.mockResolvedValue(mockResult);

      const result = await service.getConversationTurns('source-1');

      expect(conversationTestService.getConversationTurns).toHaveBeenCalledWith('source-1');
      expect(result).toBe(mockResult);
    });
  });

  // ========== executeConversation ==========

  describe('executeConversation', () => {
    it('should execute conversation and update batch stats', async () => {
      const mockConvResult = {
        sourceId: 'source-1',
        conversationId: 'conv-1',
        totalTurns: 2,
        executedTurns: 2,
        avgSimilarityScore: 80,
        minSimilarityScore: 70,
        turns: [],
      };
      mockConversationTestService.executeConversation.mockResolvedValue(mockConvResult);
      mockConversationTestService.getSourceBatchId.mockResolvedValue('batch-1');
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);

      const result = await service.executeConversation('source-1');

      expect(conversationTestService.executeConversation).toHaveBeenCalledWith(
        'source-1',
        undefined,
      );
      expect(conversationTestService.getSourceBatchId).toHaveBeenCalledWith('source-1');
      expect(batchService.updateBatchStats).toHaveBeenCalledWith('batch-1');
      expect(result).toBe(mockConvResult);
    });

    it('should NOT update batch stats when source has no batch', async () => {
      mockConversationTestService.executeConversation.mockResolvedValue({} as any);
      mockConversationTestService.getSourceBatchId.mockResolvedValue(null);

      await service.executeConversation('source-1');

      expect(batchService.updateBatchStats).not.toHaveBeenCalled();
    });
  });

  // ========== executeConversationBatch ==========

  describe('executeConversationBatch', () => {
    it('should execute batch and update batch stats', async () => {
      const mockResult = {
        batchId: 'batch-1',
        total: 5,
        successCount: 4,
        failedCount: 1,
        results: [],
      };
      mockConversationTestService.executeConversationBatch.mockResolvedValue(mockResult);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);

      const result = await service.executeConversationBatch('batch-1', true);

      expect(conversationTestService.executeConversationBatch).toHaveBeenCalledWith(
        'batch-1',
        true,
      );
      expect(batchService.updateBatchStats).toHaveBeenCalledWith('batch-1');
      expect(result).toBe(mockResult);
    });
  });

  // ========== updateTurnReview ==========

  describe('updateTurnReview', () => {
    it('should delegate to conversationTestService', async () => {
      const mockResult = { executionId: 'exec-1', reviewStatus: ReviewStatus.PASSED };
      mockConversationTestService.updateTurnReview.mockResolvedValue(mockResult);

      const result = await service.updateTurnReview('exec-1', ReviewStatus.PASSED, 'Good');

      expect(conversationTestService.updateTurnReview).toHaveBeenCalledWith(
        'exec-1',
        ReviewStatus.PASSED,
        'Good',
      );
      expect(result).toBe(mockResult);
    });
  });

  // ========== updateBatchStatus (for Processor) ==========

  describe('updateBatchStatus', () => {
    it('should delegate to batchService', async () => {
      mockBatchService.updateBatchStatus.mockResolvedValue(undefined);

      await service.updateBatchStatus('batch-1', BatchStatus.COMPLETED);

      expect(batchService.updateBatchStatus).toHaveBeenCalledWith('batch-1', BatchStatus.COMPLETED);
    });
  });

  // ========== updateBatchStats (for Processor) ==========

  describe('updateBatchStats', () => {
    it('should delegate to batchService', async () => {
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);

      await service.updateBatchStats('batch-1');

      expect(batchService.updateBatchStats).toHaveBeenCalledWith('batch-1');
    });
  });

  // ========== countCompletedExecutions (for Processor) ==========

  describe('countCompletedExecutions', () => {
    it('should delegate to executionService', async () => {
      const counts = { total: 10, success: 7, failure: 2, timeout: 1 };
      mockExecutionService.countCompletedExecutions.mockResolvedValue(counts);

      const result = await service.countCompletedExecutions('batch-1');

      expect(executionService.countCompletedExecutions).toHaveBeenCalledWith('batch-1');
      expect(result).toBe(counts);
    });
  });

  // ========== updateExecutionByBatchAndCase (for Processor) ==========

  describe('updateExecutionByBatchAndCase', () => {
    it('should delegate to executionService', async () => {
      mockExecutionService.updateExecutionByBatchAndCase.mockResolvedValue(undefined);

      await service.updateExecutionByBatchAndCase('batch-1', 'case-1', {
        executionStatus: ExecutionStatus.SUCCESS,
        durationMs: 1500,
      });

      expect(executionService.updateExecutionByBatchAndCase).toHaveBeenCalledWith(
        'batch-1',
        'case-1',
        expect.objectContaining({ executionStatus: ExecutionStatus.SUCCESS }),
      );
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { TestImportService } from './test-import.service';
import { FeishuBitableApiService } from '@core/feishu/services/feishu-bitable-api.service';
import { TestBatchService } from '../execution/test-batch.service';
import { TestExecutionService } from '../execution/test-execution.service';
import { FeishuTestSyncService } from './feishu-test-sync.service';
import { TestWriteBackService } from './test-write-back.service';
import { ConversationTestService } from '../conversation/conversation-test.service';
import { TestSuiteProcessor } from '../../test-suite.processor';
import { ConversationSourceRepository } from '../../repositories/conversation-source.repository';
import { BatchStatus, BatchSource, ExecutionStatus, TestType } from '../../enums/test.enum';

describe('TestImportService', () => {
  let service: TestImportService;
  let batchService: jest.Mocked<TestBatchService>;
  let executionService: jest.Mocked<TestExecutionService>;
  let _feishuSyncService: jest.Mocked<FeishuTestSyncService>;
  let _writeBackService: jest.Mocked<TestWriteBackService>;
  let feishuBitableApi: jest.Mocked<FeishuBitableApiService>;
  let _conversationSourceRepository: jest.Mocked<ConversationSourceRepository>;
  let _conversationTestService: jest.Mocked<ConversationTestService>;
  let testProcessor: jest.Mocked<TestSuiteProcessor>;

  const mockBatchService = {
    createBatch: jest.fn(),
    updateBatchStats: jest.fn(),
    updateBatchStatus: jest.fn(),
  };

  const mockExecutionService = {
    saveExecution: jest.fn(),
  };

  const mockFeishuSyncService = {
    getTestCases: jest.fn(),
    getConversationTestsFromDefaultTable: jest.fn(),
  };

  const mockWriteBackService = {
    writeBackSimilarityScore: jest.fn(),
  };

  const mockFeishuBitableApi = {
    getTableConfig: jest.fn(),
  };

  const mockConversationSourceRepository = {
    create: jest.fn(),
    findById: jest.fn(),
    updateStatus: jest.fn(),
  };

  const mockConversationTestService = {
    executeConversation: jest.fn(),
  };

  const mockTestProcessor = {
    addBatchTestJobs: jest.fn(),
  };

  const makeBatch = (id = 'batch-1', name = 'Test Batch') => ({
    id,
    name,
    status: BatchStatus.CREATED,
    source: BatchSource.FEISHU,
  });

  const makeParsedCase = (index: number) => ({
    caseId: `case-${index}`,
    caseName: `Case ${index}`,
    category: 'FAQ',
    message: `Question ${index}`,
    history: undefined,
    expectedOutput: `Expected ${index}`,
    testType: TestType.SCENARIO,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestImportService,
        { provide: TestBatchService, useValue: mockBatchService },
        { provide: TestExecutionService, useValue: mockExecutionService },
        { provide: FeishuTestSyncService, useValue: mockFeishuSyncService },
        { provide: TestWriteBackService, useValue: mockWriteBackService },
        { provide: FeishuBitableApiService, useValue: mockFeishuBitableApi },
        { provide: ConversationSourceRepository, useValue: mockConversationSourceRepository },
        { provide: ConversationTestService, useValue: mockConversationTestService },
        {
          provide: TestSuiteProcessor,
          useValue: mockTestProcessor,
        },
      ],
    }).compile();

    service = module.get<TestImportService>(TestImportService);
    batchService = module.get(TestBatchService);
    executionService = module.get(TestExecutionService);
    _feishuSyncService = module.get(FeishuTestSyncService);
    _writeBackService = module.get(TestWriteBackService);
    feishuBitableApi = module.get(FeishuBitableApiService);
    _conversationSourceRepository = module.get(ConversationSourceRepository);
    _conversationTestService = module.get(ConversationTestService);
    testProcessor = module.get(TestSuiteProcessor);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========== importFromFeishu ==========

  describe('importFromFeishu', () => {
    it('should throw error when feishu table has no data', async () => {
      mockFeishuSyncService.getTestCases.mockResolvedValue([]);

      await expect(
        service.importFromFeishu({
          appToken: 'app-1',
          tableId: 'table-1',
        }),
      ).rejects.toThrow('飞书表格中没有数据');
    });

    it('should create batch and save test cases', async () => {
      const cases = [makeParsedCase(1), makeParsedCase(2)];
      mockFeishuSyncService.getTestCases.mockResolvedValue(cases);
      mockBatchService.createBatch.mockResolvedValue(makeBatch());
      mockExecutionService.saveExecution.mockResolvedValue({ id: 'exec-x' } as any);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);

      const result = await service.importFromFeishu({
        appToken: 'app-1',
        tableId: 'table-1',
        batchName: 'My Batch',
        executeImmediately: false,
      });

      expect(batchService.createBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Batch',
          source: BatchSource.FEISHU,
        }),
      );
      expect(executionService.saveExecution).toHaveBeenCalledTimes(2);
      expect(result.batchId).toBe('batch-1');
      expect(result.totalImported).toBe(2);
      expect(result.cases).toHaveLength(2);
    });

    it('should save each case with PENDING execution status', async () => {
      const cases = [makeParsedCase(1)];
      mockFeishuSyncService.getTestCases.mockResolvedValue(cases);
      mockBatchService.createBatch.mockResolvedValue(makeBatch());
      mockExecutionService.saveExecution.mockResolvedValue({ id: 'exec-1' } as any);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);

      await service.importFromFeishu({ appToken: 'app-1', tableId: 'table-1' });

      expect(executionService.saveExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          executionStatus: ExecutionStatus.PENDING,
          actualOutput: '',
          toolCalls: [],
        }),
      );
    });

    it('should update batch stats after saving cases', async () => {
      const cases = [makeParsedCase(1)];
      mockFeishuSyncService.getTestCases.mockResolvedValue(cases);
      mockBatchService.createBatch.mockResolvedValue(makeBatch());
      mockExecutionService.saveExecution.mockResolvedValue({ id: 'exec-1' } as any);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);

      await service.importFromFeishu({ appToken: 'app-1', tableId: 'table-1' });

      expect(batchService.updateBatchStats).toHaveBeenCalledWith('batch-1');
    });

    it('should queue jobs when executeImmediately is true', async () => {
      const cases = [makeParsedCase(1)];
      mockFeishuSyncService.getTestCases.mockResolvedValue(cases);
      mockBatchService.createBatch.mockResolvedValue(makeBatch());
      mockExecutionService.saveExecution.mockResolvedValue({ id: 'exec-1' } as any);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);
      mockBatchService.updateBatchStatus.mockResolvedValue(undefined);
      mockTestProcessor.addBatchTestJobs.mockResolvedValue(undefined);

      await service.importFromFeishu({
        appToken: 'app-1',
        tableId: 'table-1',
        executeImmediately: true,
      });

      expect(batchService.updateBatchStatus).toHaveBeenCalledWith('batch-1', BatchStatus.RUNNING);
      // addBatchTestJobs is called async (not awaited in the main flow)
      await new Promise((resolve) => setImmediate(resolve));
      expect(testProcessor.addBatchTestJobs).toHaveBeenCalledWith('batch-1', cases);
    });

    it('should NOT queue jobs when executeImmediately is false', async () => {
      const cases = [makeParsedCase(1)];
      mockFeishuSyncService.getTestCases.mockResolvedValue(cases);
      mockBatchService.createBatch.mockResolvedValue(makeBatch());
      mockExecutionService.saveExecution.mockResolvedValue({ id: 'exec-1' } as any);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);

      await service.importFromFeishu({
        appToken: 'app-1',
        tableId: 'table-1',
        executeImmediately: false,
      });

      expect(batchService.updateBatchStatus).not.toHaveBeenCalled();
      expect(testProcessor.addBatchTestJobs).not.toHaveBeenCalled();
    });

    it('should use auto-generated batch name when batchName is not provided', async () => {
      const cases = [makeParsedCase(1)];
      mockFeishuSyncService.getTestCases.mockResolvedValue(cases);
      mockBatchService.createBatch.mockResolvedValue(makeBatch());
      mockExecutionService.saveExecution.mockResolvedValue({ id: 'exec-1' } as any);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);

      await service.importFromFeishu({ appToken: 'app-1', tableId: 'table-1' });

      const createCall = batchService.createBatch.mock.calls[0][0];
      expect(createCall.name).toContain('飞书导入');
    });
  });

  // ========== quickCreateBatch (scenario type) ==========

  describe('quickCreateBatch', () => {
    it('should use testSuite table config for scenario type', async () => {
      mockFeishuBitableApi.getTableConfig.mockReturnValue({
        appToken: 'test-app',
        tableId: 'test-table',
      });
      mockFeishuSyncService.getTestCases.mockResolvedValue([makeParsedCase(1)]);
      mockBatchService.createBatch.mockResolvedValue(makeBatch());
      mockExecutionService.saveExecution.mockResolvedValue({ id: 'exec-1' } as any);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);
      mockBatchService.updateBatchStatus.mockResolvedValue(undefined);
      mockTestProcessor.addBatchTestJobs.mockResolvedValue(undefined);

      await service.quickCreateBatch({ testType: TestType.SCENARIO });

      expect(feishuBitableApi.getTableConfig).toHaveBeenCalledWith('testSuite');
    });

    it('should use conversation batch creation for conversation type', async () => {
      mockFeishuSyncService.getConversationTestsFromDefaultTable.mockResolvedValue({
        appToken: 'valid-app',
        tableId: 'valid-table',
        conversations: [
          {
            recordId: 'rec-1',
            conversationId: 'conv-1',
            participantName: 'Alice',
            rawText: 'raw conversation text here',
            parseResult: { success: true, messages: [], totalTurns: 1 },
            testType: TestType.CONVERSATION,
          },
        ],
      });
      mockBatchService.createBatch.mockResolvedValue(makeBatch('batch-conv', 'Conv Batch'));
      mockConversationSourceRepository.create.mockResolvedValue({ id: 'src-1' } as any);
      mockBatchService.updateBatchStatus.mockResolvedValue(undefined);
      mockConversationTestService.executeConversation.mockResolvedValue({
        sourceId: 'src-1',
        conversationId: 'conv-1',
        totalTurns: 1,
        executedTurns: 1,
        avgSimilarityScore: 80,
        minSimilarityScore: 80,
        turns: [],
      });
      mockWriteBackService.writeBackSimilarityScore.mockResolvedValue({ success: true });
      mockConversationSourceRepository.findById.mockResolvedValue({
        id: 'src-1',
        feishu_record_id: 'rec-1',
      } as any);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);

      const result = await service.quickCreateBatch({ testType: TestType.CONVERSATION });

      expect(result.batchId).toBe('batch-conv');
    });

    it('should throw error when conversation table has no data', async () => {
      mockFeishuSyncService.getConversationTestsFromDefaultTable.mockResolvedValue({
        appToken: 'app',
        tableId: 'table',
        conversations: [],
      });

      await expect(service.quickCreateBatch({ testType: TestType.CONVERSATION })).rejects.toThrow(
        '验证集表中没有回归验证数据',
      );
    });

    it('should use custom batchName when provided', async () => {
      mockFeishuBitableApi.getTableConfig.mockReturnValue({
        appToken: 'app',
        tableId: 'table',
      });
      mockFeishuSyncService.getTestCases.mockResolvedValue([makeParsedCase(1)]);
      mockBatchService.createBatch.mockResolvedValue(makeBatch());
      mockExecutionService.saveExecution.mockResolvedValue({ id: 'exec-1' } as any);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);
      mockBatchService.updateBatchStatus.mockResolvedValue(undefined);
      mockTestProcessor.addBatchTestJobs.mockResolvedValue(undefined);

      await service.quickCreateBatch({ batchName: 'Custom Batch Name' });

      expect(batchService.createBatch).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Custom Batch Name' }),
      );
    });

    it('should default to SCENARIO type when no testType specified', async () => {
      mockFeishuBitableApi.getTableConfig.mockReturnValue({
        appToken: 'app',
        tableId: 'table',
      });
      mockFeishuSyncService.getTestCases.mockResolvedValue([makeParsedCase(1)]);
      mockBatchService.createBatch.mockResolvedValue(makeBatch());
      mockExecutionService.saveExecution.mockResolvedValue({ id: 'exec-1' } as any);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);
      mockBatchService.updateBatchStatus.mockResolvedValue(undefined);
      mockTestProcessor.addBatchTestJobs.mockResolvedValue(undefined);

      await service.quickCreateBatch();

      // Should use testSuite (scenario) table
      expect(feishuBitableApi.getTableConfig).toHaveBeenCalledWith('testSuite');
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { TestImportService } from '@biz/test-suite/services/test-import.service';
import { FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';
import { TestBatchService } from '@biz/test-suite/services/test-batch.service';
import { TestExecutionService } from '@biz/test-suite/services/test-execution.service';
import { TestWriteBackService } from '@biz/test-suite/services/test-write-back.service';
import { ConversationTestService } from '@biz/test-suite/services/conversation-test.service';
import { TestSuiteProcessor } from '@biz/test-suite/test-suite.processor';
import { ConversationSnapshotRepository } from '@biz/test-suite/repositories/conversation-snapshot.repository';
import { ConversationParserService } from '@evaluation/conversation-parser.service';
import { BatchStatus, BatchSource, ExecutionStatus, TestType } from '@biz/test-suite/enums/test.enum';

describe('TestImportService', () => {
  let service: TestImportService;
  let batchService: jest.Mocked<TestBatchService>;
  let executionService: jest.Mocked<TestExecutionService>;
  let _writeBackService: jest.Mocked<TestWriteBackService>;
  let feishuBitableApi: jest.Mocked<FeishuBitableApiService>;
  let _conversationSnapshotRepository: jest.Mocked<ConversationSnapshotRepository>;
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

  const mockWriteBackService = {
    writeBackSimilarityScore: jest.fn(),
  };

  const mockFeishuBitableApi = {
    getTableConfig: jest.fn(),
    buildFieldNameToIdMap: jest.fn((fields) =>
      fields.reduce(
        (acc: Record<string, string>, field: { field_name: string; field_id: string }) => {
          acc[field.field_name] = field.field_id;
          return acc;
        },
        {},
      ),
    ),
  };

  const mockConversationSnapshotRepository = {
    create: jest.fn(),
    findById: jest.fn(),
    updateStatus: jest.fn(),
  };

  const mockConversationTestService = {
    executeConversation: jest.fn(),
  };

  const mockParserService = {
    parseConversation: jest.fn(),
    splitIntoTurns: jest.fn(),
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
        { provide: TestWriteBackService, useValue: mockWriteBackService },
        { provide: FeishuBitableApiService, useValue: mockFeishuBitableApi },
        { provide: ConversationSnapshotRepository, useValue: mockConversationSnapshotRepository },
        { provide: ConversationTestService, useValue: mockConversationTestService },
        { provide: ConversationParserService, useValue: mockParserService },
        {
          provide: TestSuiteProcessor,
          useValue: mockTestProcessor,
        },
      ],
    }).compile();

    service = module.get<TestImportService>(TestImportService);
    batchService = module.get(TestBatchService);
    executionService = module.get(TestExecutionService);
    _writeBackService = module.get(TestWriteBackService);
    feishuBitableApi = module.get(FeishuBitableApiService);
    _conversationSnapshotRepository = module.get(ConversationSnapshotRepository);
    _conversationTestService = module.get(ConversationTestService);
    testProcessor = module.get(TestSuiteProcessor);

    // Spy on service's own methods that were previously delegated to FeishuTestSyncService
    jest.spyOn(service, 'getTestCases' as any).mockResolvedValue([]);
    jest.spyOn(service, 'getConversationTestsFromDefaultTable' as any).mockResolvedValue({
      appToken: '',
      tableId: '',
      conversations: [],
    });

    jest.clearAllMocks();
  });

  const mockServiceGetTestCases = () =>
    jest.spyOn(service as any, 'getTestCases');
  const mockServiceGetConversationTests = () =>
    jest.spyOn(service as any, 'getConversationTestsFromDefaultTable');

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========== importFromFeishu ==========

  describe('importFromFeishu', () => {
    it('should throw error when feishu table has no data', async () => {
      mockServiceGetTestCases().mockResolvedValue([]);

      await expect(
        service.importFromFeishu({
          appToken: 'app-1',
          tableId: 'table-1',
        }),
      ).rejects.toThrow('飞书表格中没有数据');
    });

    it('should create batch and save test cases', async () => {
      const cases = [makeParsedCase(1), makeParsedCase(2)];
      mockServiceGetTestCases().mockResolvedValue(cases);
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
      mockServiceGetTestCases().mockResolvedValue(cases);
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
      mockServiceGetTestCases().mockResolvedValue(cases);
      mockBatchService.createBatch.mockResolvedValue(makeBatch());
      mockExecutionService.saveExecution.mockResolvedValue({ id: 'exec-1' } as any);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);

      await service.importFromFeishu({ appToken: 'app-1', tableId: 'table-1' });

      expect(batchService.updateBatchStats).toHaveBeenCalledWith('batch-1');
    });

    it('should queue jobs when executeImmediately is true', async () => {
      const cases = [makeParsedCase(1)];
      mockServiceGetTestCases().mockResolvedValue(cases);
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
      mockServiceGetTestCases().mockResolvedValue(cases);
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
      mockServiceGetTestCases().mockResolvedValue(cases);
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
      mockServiceGetTestCases().mockResolvedValue([makeParsedCase(1)]);
      mockBatchService.createBatch.mockResolvedValue(makeBatch());
      mockExecutionService.saveExecution.mockResolvedValue({ id: 'exec-1' } as any);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);
      mockBatchService.updateBatchStatus.mockResolvedValue(undefined);
      mockTestProcessor.addBatchTestJobs.mockResolvedValue(undefined);

      await service.quickCreateBatch({ testType: TestType.SCENARIO });

      expect(feishuBitableApi.getTableConfig).toHaveBeenCalledWith('testSuite');
    });

    it('should use conversation batch creation for conversation type', async () => {
      mockServiceGetConversationTests().mockResolvedValue({
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
      mockConversationSnapshotRepository.create.mockResolvedValue({ id: 'src-1' } as any);
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
      mockConversationSnapshotRepository.findById.mockResolvedValue({
        id: 'src-1',
        feishu_record_id: 'rec-1',
      } as any);
      mockBatchService.updateBatchStats.mockResolvedValue(undefined);

      const result = await service.quickCreateBatch({ testType: TestType.CONVERSATION });

      expect(result.batchId).toBe('batch-conv');
    });

    it('should throw error when conversation table has no data', async () => {
      mockServiceGetConversationTests().mockResolvedValue({
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
      mockServiceGetTestCases().mockResolvedValue([makeParsedCase(1)]);
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
      mockServiceGetTestCases().mockResolvedValue([makeParsedCase(1)]);
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

  describe('parseRecords', () => {
    it('should skip disabled records and use 核心检查点 as expected output fallback', () => {
      const fields = [
        { field_id: 'fld_name', field_name: '用例名称', type: 1 },
        { field_id: 'fld_message', field_name: '用户消息', type: 1 },
        { field_id: 'fld_category', field_name: '分类', type: 1 },
        { field_id: 'fld_enabled', field_name: '是否启用', type: 7 },
        { field_id: 'fld_checkpoint', field_name: '核心检查点', type: 1 },
      ];

      const records = [
        {
          record_id: 'rec-disabled',
          fields: {
            fld_name: 'disabled-case',
            fld_message: '不要导入我',
            fld_enabled: false,
            fld_checkpoint: '不会被解析',
          },
        },
        {
          record_id: 'rec-enabled',
          fields: {
            fld_name: 'enabled-case',
            fld_message: '请帮我找兼职',
            fld_category: '3-岗位推荐问题',
            fld_enabled: true,
            fld_checkpoint: '应先问具体地址，再推荐岗位',
          },
        },
      ] as any;

      const cases = service.parseRecords(records, fields as any);

      expect(cases).toHaveLength(1);
      expect(cases[0]).toEqual(
        expect.objectContaining({
          caseId: 'rec-enabled',
          caseName: 'enabled-case',
          category: '3-岗位推荐问题',
          message: '请帮我找兼职',
          expectedOutput: '应先问具体地址，再推荐岗位',
        }),
      );
    });
  });

  describe('parseValidationSetRecords', () => {
    it('should skip disabled validation records', () => {
      mockParserService.parseConversation.mockReturnValue({
        success: true,
        messages: [],
        totalTurns: 1,
      });

      const fields = [
        { field_id: 'fld_name', field_name: '候选人微信昵称', type: 1 },
        { field_id: 'fld_conversation', field_name: '完整对话记录', type: 1 },
        { field_id: 'fld_enabled', field_name: '是否启用', type: 7 },
      ];

      const conversations = service.parseValidationSetRecords(
        [
          {
            record_id: 'rec-disabled',
            fields: {
              fld_name: '候选人A',
              fld_conversation: '[04/22 10:00 候选人] 你好',
              fld_enabled: false,
            },
          },
          {
            record_id: 'rec-enabled',
            fields: {
              fld_name: '候选人B',
              fld_conversation: '[04/22 10:00 候选人] 在吗',
              fld_enabled: true,
            },
          },
        ] as any,
        fields as any,
      );

      expect(conversations).toHaveLength(1);
      expect(conversations[0]).toEqual(
        expect.objectContaining({
          recordId: 'rec-enabled',
          participantName: '候选人B',
          rawText: '[04/22 10:00 候选人] 在吗',
        }),
      );
      expect(mockParserService.parseConversation).toHaveBeenCalledTimes(1);
    });
  });
});

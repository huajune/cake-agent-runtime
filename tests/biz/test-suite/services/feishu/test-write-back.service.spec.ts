import { Test, TestingModule } from '@nestjs/testing';
import { TestWriteBackService } from '@biz/test-suite/services/feishu/test-write-back.service';
import { FeishuBitableApiService } from '@core/feishu/services/feishu-bitable-api.service';
import { TestExecutionService } from '@biz/test-suite/services/execution/test-execution.service';
import { FeishuTestStatus } from '@biz/test-suite/enums/test.enum';

// Mock the feishu-bitable.config constants
jest.mock('@core/feishu/constants/feishu-bitable.config', () => ({
  testSuiteFieldNames: {
    testStatus: '测试状态',
    lastTestTime: '最近测试时间',
    testBatch: '测试批次',
    errorReason: '错误原因',
  },
  validationSetFieldNames: {
    similarityScore: '相似度分数',
    lastTestTime: '最近测试时间',
  },
}));

describe('TestWriteBackService', () => {
  let service: TestWriteBackService;
  let _executionService: jest.Mocked<TestExecutionService>;
  let bitableApi: jest.Mocked<FeishuBitableApiService>;

  const mockExecutionService = {
    getExecution: jest.fn(),
  };

  const mockBitableApi = {
    getTableConfig: jest.fn(),
    updateRecord: jest.fn(),
  };

  const makeExecution = (overrides: Record<string, unknown> = {}) => ({
    id: 'exec-1',
    case_id: 'rec-feishu-1',
    batch_id: 'batch-1',
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestWriteBackService,
        { provide: TestExecutionService, useValue: mockExecutionService },
        { provide: FeishuBitableApiService, useValue: mockBitableApi },
      ],
    }).compile();

    service = module.get<TestWriteBackService>(TestWriteBackService);
    _executionService = module.get(TestExecutionService);
    bitableApi = module.get(FeishuBitableApiService);

    jest.clearAllMocks();

    // Default table config mock
    mockBitableApi.getTableConfig.mockReturnValue({
      appToken: 'app-token',
      tableId: 'table-id',
    });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========== writeBackToFeishu ==========

  describe('writeBackToFeishu', () => {
    it('should return error when execution not found', async () => {
      mockExecutionService.getExecution.mockResolvedValue(null);

      const result = await service.writeBackToFeishu('exec-1', FeishuTestStatus.PASSED);

      expect(result.success).toBe(false);
      expect(result.error).toBe('执行记录不存在');
    });

    it('should return error when execution has no case_id', async () => {
      mockExecutionService.getExecution.mockResolvedValue(makeExecution({ case_id: null }));

      const result = await service.writeBackToFeishu('exec-1', FeishuTestStatus.PASSED);

      expect(result.success).toBe(false);
      expect(result.error).toBe('执行记录缺少飞书记录 ID');
    });

    it('should call writeBackResult with correct parameters when execution exists', async () => {
      mockExecutionService.getExecution.mockResolvedValue(makeExecution());
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      const result = await service.writeBackToFeishu('exec-1', FeishuTestStatus.PASSED);

      expect(bitableApi.updateRecord).toHaveBeenCalledWith(
        'app-token',
        'table-id',
        'rec-feishu-1',
        expect.objectContaining({ 测试状态: FeishuTestStatus.PASSED }),
      );
      expect(result.success).toBe(true);
    });

    it('should pass errorReason to writeBackResult when provided', async () => {
      mockExecutionService.getExecution.mockResolvedValue(makeExecution());
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackToFeishu('exec-1', FeishuTestStatus.FAILED, '回答错误');

      expect(bitableApi.updateRecord).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ 错误原因: '回答错误' }),
      );
    });
  });

  // ========== batchWriteBackToFeishu ==========

  describe('batchWriteBackToFeishu', () => {
    it('should process all items and return counts', async () => {
      mockExecutionService.getExecution.mockResolvedValue(makeExecution());
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      const items = [
        { executionId: 'exec-1', testStatus: FeishuTestStatus.PASSED },
        { executionId: 'exec-2', testStatus: FeishuTestStatus.FAILED, errorReason: 'wrong' },
      ];

      const result = await service.batchWriteBackToFeishu(items);

      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should accumulate errors when execution not found', async () => {
      mockExecutionService.getExecution
        .mockResolvedValueOnce(makeExecution())
        .mockResolvedValueOnce(null);
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      const items = [
        { executionId: 'exec-ok', testStatus: FeishuTestStatus.PASSED },
        { executionId: 'exec-missing', testStatus: FeishuTestStatus.PASSED },
      ];

      const result = await service.batchWriteBackToFeishu(items);

      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('exec-missing');
    });

    it('should accumulate errors when execution has no case_id', async () => {
      mockExecutionService.getExecution.mockResolvedValue(makeExecution({ case_id: null }));

      const items = [{ executionId: 'exec-1', testStatus: FeishuTestStatus.PASSED }];

      const result = await service.batchWriteBackToFeishu(items);

      expect(result.failed).toBe(1);
      expect(result.errors[0]).toContain('exec-1');
    });
  });

  // ========== writeBackResult ==========

  describe('writeBackResult', () => {
    it('should write PASSED status to feishu record', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      const result = await service.writeBackResult('rec-1', FeishuTestStatus.PASSED, 'batch-1');

      expect(bitableApi.getTableConfig).toHaveBeenCalledWith('testSuite');
      expect(bitableApi.updateRecord).toHaveBeenCalledWith(
        'app-token',
        'table-id',
        'rec-1',
        expect.objectContaining({ 测试状态: FeishuTestStatus.PASSED }),
      );
      expect(result.success).toBe(true);
    });

    it('should include batchId in update fields when provided', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackResult('rec-1', FeishuTestStatus.PASSED, 'batch-123');

      expect(bitableApi.updateRecord).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ 测试批次: 'batch-123' }),
      );
    });

    it('should NOT include errorReason field for PASSED status', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackResult('rec-1', FeishuTestStatus.PASSED, undefined, '某个原因');

      const updateFields = bitableApi.updateRecord.mock.calls[0][3];
      expect(updateFields['错误原因']).toBeUndefined();
    });

    it('should include errorReason field only for FAILED status', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackResult('rec-1', FeishuTestStatus.FAILED, undefined, '回答内容错误');

      const updateFields = bitableApi.updateRecord.mock.calls[0][3];
      expect(updateFields['错误原因']).toBe('回答内容错误');
    });

    it('should return error when bitableApi call fails', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({
        success: false,
        error: 'Record not found in Feishu',
      });

      const result = await service.writeBackResult('rec-1', FeishuTestStatus.PASSED);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Record not found in Feishu');
    });

    it('should handle exceptions and return error result', async () => {
      mockBitableApi.updateRecord.mockRejectedValue(new Error('Network error'));

      const result = await service.writeBackResult('rec-1', FeishuTestStatus.PASSED);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should always include lastTestTime in update fields', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackResult('rec-1', FeishuTestStatus.PASSED);

      const updateFields = bitableApi.updateRecord.mock.calls[0][3];
      expect(updateFields['最近测试时间']).toBeDefined();
    });
  });

  // ========== batchWriteBackResults ==========

  describe('batchWriteBackResults', () => {
    it('should return success count for all successful writes', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      const items = [
        { recordId: 'rec-1', testStatus: FeishuTestStatus.PASSED },
        { recordId: 'rec-2', testStatus: FeishuTestStatus.FAILED },
      ];

      const result = await service.batchWriteBackResults(items);

      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should count failures and accumulate error messages', async () => {
      mockBitableApi.updateRecord
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: 'Feishu API error' });

      const items = [
        { recordId: 'rec-1', testStatus: FeishuTestStatus.PASSED },
        { recordId: 'rec-2', testStatus: FeishuTestStatus.FAILED },
      ];

      const result = await service.batchWriteBackResults(items);

      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors[0]).toContain('rec-2');
    });
  });

  // ========== writeBackSimilarityScore ==========

  describe('writeBackSimilarityScore', () => {
    it('should write similarity score to validationSet table', async () => {
      mockBitableApi.getTableConfig.mockReturnValue({
        appToken: 'validation-app',
        tableId: 'validation-table',
      });
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      const result = await service.writeBackSimilarityScore('rec-1', 85);

      expect(bitableApi.getTableConfig).toHaveBeenCalledWith('validationSet');
      expect(bitableApi.updateRecord).toHaveBeenCalledWith(
        'validation-app',
        'validation-table',
        'rec-1',
        expect.objectContaining({ 相似度分数: 85 }),
      );
      expect(result.success).toBe(true);
    });

    it('should not include similarityScore field when null', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackSimilarityScore('rec-1', null);

      const updateFields = bitableApi.updateRecord.mock.calls[0][3];
      expect(updateFields['相似度分数']).toBeUndefined();
    });

    it('should always include lastTestTime even when score is null', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackSimilarityScore('rec-1', null);

      const updateFields = bitableApi.updateRecord.mock.calls[0][3];
      expect(updateFields['最近测试时间']).toBeDefined();
    });

    it('should return error when bitableApi call fails', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({
        success: false,
        error: 'Permission denied',
      });

      const result = await service.writeBackSimilarityScore('rec-1', 70);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });

    it('should handle exceptions gracefully', async () => {
      mockBitableApi.updateRecord.mockRejectedValue(new Error('Connection timeout'));

      const result = await service.writeBackSimilarityScore('rec-1', 75);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection timeout');
    });
  });
});

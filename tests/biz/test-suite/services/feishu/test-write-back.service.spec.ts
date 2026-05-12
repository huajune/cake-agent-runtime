import { Test, TestingModule } from '@nestjs/testing';
import { TestWriteBackService } from '@biz/test-suite/services/test-write-back.service';
import { FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';
import { TestExecutionService } from '@biz/test-suite/services/test-execution.service';
import { FeishuTestStatus } from '@biz/test-suite/enums/test.enum';

// Mock the feishu-bitable.config constants
jest.mock('@infra/feishu/constants/feishu-bitable.config', () => ({
  testSuiteFieldNames: {
    testStatus: ['测试状态'],
    lastTestTime: ['最近测试时间'],
    testBatch: ['测试批次'],
    errorReason: ['错误原因'],
    reviewSummary: ['评审摘要'],
  },
  validationSetFieldNames: {
    similarityScore: ['相似度分数'],
    lastTestTime: ['最近测试时间'],
    evaluationSummary: ['评估摘要'],
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
    getFields: jest.fn(),
    updateRecord: jest.fn(),
  };

  const makeExecution = (overrides: Record<string, unknown> = {}) => ({
    id: 'exec-1',
    case_id: 'recvifeishu01',
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
    mockBitableApi.getFields.mockResolvedValue([
      { field_name: '测试状态' },
      { field_name: '最近测试时间' },
      { field_name: '测试批次' },
      { field_name: '错误原因' },
      { field_name: '评审摘要' },
      { field_name: '相似度分数' },
      { field_name: '评估摘要' },
    ]);
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
        'recvifeishu01',
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

      const result = await service.writeBackResult('recvifeishu01', FeishuTestStatus.PASSED, 'batch-1');

      expect(bitableApi.getTableConfig).toHaveBeenCalledWith('testSuite');
      expect(bitableApi.updateRecord).toHaveBeenCalledWith(
        'app-token',
        'table-id',
        'recvifeishu01',
        expect.objectContaining({ 测试状态: FeishuTestStatus.PASSED }),
      );
      expect(result.success).toBe(true);
    });

    it('should include batchId in update fields when provided', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackResult('recvifeishu01', FeishuTestStatus.PASSED, 'batch-123');

      expect(bitableApi.updateRecord).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ 测试批次: 'batch-123' }),
      );
    });

    it('should NOT include errorReason field for PASSED status', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackResult('recvifeishu01', FeishuTestStatus.PASSED, undefined, '某个原因');

      const updateFields = bitableApi.updateRecord.mock.calls[0][3];
      expect(updateFields['错误原因']).toBeUndefined();
    });

    it('should include errorReason field only for FAILED status', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackResult('recvifeishu01', FeishuTestStatus.FAILED, undefined, '回答内容错误');

      const updateFields = bitableApi.updateRecord.mock.calls[0][3];
      expect(updateFields['错误原因']).toBe('回答内容错误');
    });

    it('should include reviewSummary when the field exists', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackResult(
        'recvifeishu01',
        FeishuTestStatus.PASSED,
        'batch-1',
        undefined,
        '人工评审通过',
      );

      const updateFields = bitableApi.updateRecord.mock.calls[0][3];
      expect(updateFields['评审摘要']).toBe('人工评审通过');
    });

    it('should return error when bitableApi call fails', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({
        success: false,
        error: 'Record not found in Feishu',
      });

      const result = await service.writeBackResult('recvifeishu01', FeishuTestStatus.PASSED);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Record not found in Feishu');
    });

    it('should handle exceptions and return error result', async () => {
      mockBitableApi.updateRecord.mockRejectedValue(new Error('Network error'));

      const result = await service.writeBackResult('recvifeishu01', FeishuTestStatus.PASSED);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should always include lastTestTime in update fields', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackResult('recvifeishu01', FeishuTestStatus.PASSED);

      const updateFields = bitableApi.updateRecord.mock.calls[0][3];
      expect(updateFields['最近测试时间']).toBeDefined();
    });
  });

  // ========== batchWriteBackResults ==========

  describe('batchWriteBackResults', () => {
    it('should return success count for all successful writes', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      const items = [
        { recordId: 'recvifeishu01', testStatus: FeishuTestStatus.PASSED },
        { recordId: 'recvifeishu02', testStatus: FeishuTestStatus.FAILED },
      ];

      const result = await service.batchWriteBackResults(items);

      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should count failures and accumulate error messages', async () => {
      mockBitableApi.updateRecord.mockReset();
      mockBitableApi.updateRecord
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValue({ success: false, error: 'Feishu API error' });

      const items = [
        { recordId: 'recvifeishu01', testStatus: FeishuTestStatus.PASSED },
        { recordId: 'recvifeishu02', testStatus: FeishuTestStatus.FAILED },
      ];

      const result = await service.batchWriteBackResults(items);

      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors[0]).toContain('recvifeishu02');
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

      const result = await service.writeBackSimilarityScore('recvifeishu01', 85);

      expect(bitableApi.getTableConfig).toHaveBeenCalledWith('validationSet');
      expect(bitableApi.updateRecord).toHaveBeenCalledWith(
        'validation-app',
        'validation-table',
        'recvifeishu01',
        expect.objectContaining({ 相似度分数: 85 }),
      );
      expect(result.success).toBe(true);
    });

    it('should not include similarityScore field when null', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackSimilarityScore('recvifeishu01', null);

      const updateFields = bitableApi.updateRecord.mock.calls[0][3];
      expect(updateFields['相似度分数']).toBeUndefined();
    });

    it('should always include lastTestTime even when score is null', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackSimilarityScore('recvifeishu01', null);

      const updateFields = bitableApi.updateRecord.mock.calls[0][3];
      expect(updateFields['最近测试时间']).toBeDefined();
    });

    it('should include evaluationSummary when provided', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackSimilarityScore('recvifeishu01', 75, {
        evaluationSummary: '评审摘要\n第2轮 失败（Claude）：岗位不匹配',
      });

      const updateFields = bitableApi.updateRecord.mock.calls[0][3];
      expect(updateFields['评估摘要']).toBe('评审摘要\n第2轮 失败（Claude）：岗位不匹配');
    });

    it('should return error when bitableApi call fails', async () => {
      mockBitableApi.updateRecord.mockResolvedValue({
        success: false,
        error: 'Permission denied',
      });

      const result = await service.writeBackSimilarityScore('recvifeishu01', 70);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });

    it('should handle exceptions gracefully', async () => {
      mockBitableApi.updateRecord.mockRejectedValue(new Error('Connection timeout'));

      const result = await service.writeBackSimilarityScore('recvifeishu01', 75);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection timeout');
    });
  });

  // ========== resolveFeishuRecordId（caseId → recordId lookup） ==========

  describe('caseId → recordId lookup（direct batch 路径）', () => {
    /**
     * 历史背景：direct batch 创建 execution 时存的是稳定 caseId（如 P1-SCN-spen553o），
     * 不是飞书 recordId。writeBack 服务必须先按 caseId 反查飞书测试集拿到真实 recordId。
     */
    beforeEach(() => {
      // 扩展 mock：getFields 多返回一个稳定 ID 字段
      mockBitableApi.getFields.mockResolvedValue([
        { field_name: '测试状态' },
        { field_name: '最近测试时间' },
        { field_name: '测试批次' },
        { field_name: '错误原因' },
        { field_name: '评审摘要' },
        { field_name: '相似度分数' },
        { field_name: '评估摘要' },
        { field_name: '用例ID' },
      ]);
    });

    it('应当通过 stableId 反查飞书 recordId 后写回成功', async () => {
      const queryRecords = jest.fn().mockResolvedValue([{ record_id: 'recvilookup001' }]);
      (mockBitableApi as unknown as { queryRecords: typeof queryRecords }).queryRecords =
        queryRecords;
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      const result = await service.writeBackResult(
        'P1-SCN-spen553o',
        FeishuTestStatus.PASSED,
        'batch-direct',
      );

      expect(queryRecords).toHaveBeenCalledWith(
        'app-token',
        'table-id',
        'CurrentValue.[用例ID] = "P1-SCN-spen553o"',
        1,
      );
      expect(mockBitableApi.updateRecord).toHaveBeenCalledWith(
        'app-token',
        'table-id',
        'recvilookup001',
        expect.any(Object),
      );
      expect(result.success).toBe(true);
    });

    it('当 stableId 在飞书中查不到时应返回明确错误', async () => {
      const queryRecords = jest.fn().mockResolvedValue([]);
      (mockBitableApi as unknown as { queryRecords: typeof queryRecords }).queryRecords =
        queryRecords;

      const result = await service.writeBackResult('SCN-NON-EXISTENT', FeishuTestStatus.PASSED);

      expect(result.success).toBe(false);
      expect(result.error).toContain('未找到对应记录');
      expect(mockBitableApi.updateRecord).not.toHaveBeenCalled();
    });

    it('对 rec 前缀的真实 recordId 应直接走更新（不触发 lookup）', async () => {
      const queryRecords = jest.fn();
      (mockBitableApi as unknown as { queryRecords: typeof queryRecords }).queryRecords =
        queryRecords;
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      const result = await service.writeBackResult('recvirealfeishu01', FeishuTestStatus.PASSED);

      expect(queryRecords).not.toHaveBeenCalled();
      expect(mockBitableApi.updateRecord).toHaveBeenCalledWith(
        'app-token',
        'table-id',
        'recvirealfeishu01',
        expect.any(Object),
      );
      expect(result.success).toBe(true);
    });

    it('lookup 结果应在进程内缓存，重复调用同一 stableId 不再查飞书', async () => {
      const queryRecords = jest.fn().mockResolvedValue([{ record_id: 'recvicache01' }]);
      (mockBitableApi as unknown as { queryRecords: typeof queryRecords }).queryRecords =
        queryRecords;
      mockBitableApi.updateRecord.mockResolvedValue({ success: true });

      await service.writeBackResult('P1-SCN-cached', FeishuTestStatus.PASSED);
      await service.writeBackResult('P1-SCN-cached', FeishuTestStatus.FAILED);

      expect(queryRecords).toHaveBeenCalledTimes(1);
      expect(mockBitableApi.updateRecord).toHaveBeenCalledTimes(2);
    });
  });
});

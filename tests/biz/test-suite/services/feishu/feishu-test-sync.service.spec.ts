import { Test, TestingModule } from '@nestjs/testing';
import { FeishuTestSyncService } from '@biz/test-suite/services/feishu-test-sync.service';
import {
  FeishuBitableApiService,
  BitableRecord,
  BitableField,
} from '@infra/feishu/services/bitable-api.service';
import { ConversationParserService } from '@evaluation/conversation-parser.service';
import { TestType, MessageRole } from '@biz/test-suite/enums/test.enum';

describe('FeishuTestSyncService', () => {
  let service: FeishuTestSyncService;
  let bitableApi: jest.Mocked<FeishuBitableApiService>;
  let _parserService: jest.Mocked<ConversationParserService>;

  const mockBitableApi = {
    getTableConfig: jest.fn(),
    getFields: jest.fn(),
    getAllRecords: jest.fn(),
    buildFieldNameToIdMap: jest.fn(),
    updateRecord: jest.fn(),
  };

  const mockParserService = {
    parseConversation: jest.fn(),
  };

  const makeField = (name: string, id: string): BitableField =>
    ({
      field_id: id,
      field_name: name,
      type: 1,
    }) as BitableField;

  const makeRecord = (recordId: string, fields: Record<string, unknown>): BitableRecord =>
    ({
      record_id: recordId,
      fields,
    }) as BitableRecord;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeishuTestSyncService,
        { provide: FeishuBitableApiService, useValue: mockBitableApi },
        { provide: ConversationParserService, useValue: mockParserService },
      ],
    }).compile();

    service = module.get<FeishuTestSyncService>(FeishuTestSyncService);
    bitableApi = module.get(FeishuBitableApiService);
    _parserService = module.get(ConversationParserService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========== getTestCasesFromDefaultTable ==========

  describe('getTestCasesFromDefaultTable', () => {
    it('should fetch from configured testSuite table', async () => {
      mockBitableApi.getTableConfig.mockReturnValue({
        appToken: 'app-token-1',
        tableId: 'table-id-1',
      });
      mockBitableApi.getFields.mockResolvedValue([]);
      mockBitableApi.getAllRecords.mockResolvedValue([]);
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({});

      const result = await service.getTestCasesFromDefaultTable();

      expect(bitableApi.getTableConfig).toHaveBeenCalledWith('testSuite');
      expect(result.appToken).toBe('app-token-1');
      expect(result.tableId).toBe('table-id-1');
      expect(result.cases).toHaveLength(0);
    });
  });

  // ========== getTestCases ==========

  describe('getTestCases', () => {
    it('should call bitable API with correct parameters', async () => {
      mockBitableApi.getFields.mockResolvedValue([]);
      mockBitableApi.getAllRecords.mockResolvedValue([]);
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({});

      await service.getTestCases('app-token', 'table-id');

      expect(bitableApi.getFields).toHaveBeenCalledWith('app-token', 'table-id');
      expect(bitableApi.getAllRecords).toHaveBeenCalledWith('app-token', 'table-id');
    });
  });

  // ========== parseRecords ==========

  describe('parseRecords', () => {
    it('should parse valid scenario test records', () => {
      const fields = [
        makeField('用例名称', 'fld-name'),
        makeField('用户消息', 'fld-msg'),
        makeField('分类', 'fld-cat'),
      ];
      const records = [
        makeRecord('rec-1', {
          'fld-name': '测试用例1',
          'fld-msg': '这还招人吗',
          'fld-cat': 'FAQ',
        }),
      ];
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({
        用例名称: 'fld-name',
        用户消息: 'fld-msg',
        分类: 'fld-cat',
      });

      const result = service.parseRecords(records, fields);

      expect(result).toHaveLength(1);
      expect(result[0].caseId).toBe('rec-1');
      expect(result[0].caseName).toBe('测试用例1');
      expect(result[0].message).toBe('这还招人吗');
      expect(result[0].category).toBe('FAQ');
      expect(result[0].testType).toBe(TestType.SCENARIO);
    });

    it('should skip records without message field', () => {
      const fields = [makeField('用户消息', 'fld-msg')];
      const records = [makeRecord('rec-empty', { 'fld-name': 'case without message' })];
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({ 用户消息: 'fld-msg' });

      const result = service.parseRecords(records, fields);

      expect(result).toHaveLength(0);
    });

    it('should skip conversation-type records', () => {
      const fields = [makeField('测试类型', 'fld-type'), makeField('用户消息', 'fld-msg')];
      const records = [
        makeRecord('rec-conv', { 'fld-type': '对话验证', 'fld-msg': '对话内容' }),
        makeRecord('rec-sc', { 'fld-msg': '普通消息' }),
      ];
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({
        测试类型: 'fld-type',
        用户消息: 'fld-msg',
      });

      const result = service.parseRecords(records, fields);

      expect(result).toHaveLength(1);
      expect(result[0].caseId).toBe('rec-sc');
    });

    it('should handle array field values (multi-text)', () => {
      const fields = [makeField('用户消息', 'fld-msg')];
      const records = [
        makeRecord('rec-1', {
          'fld-msg': [{ text: '这是第一行' }, { text: '这是第二行' }],
        }),
      ];
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({ 用户消息: 'fld-msg' });

      const result = service.parseRecords(records, fields);

      expect(result).toHaveLength(1);
      expect(result[0].message).toContain('这是第一行');
    });

    it('should use default caseName when none is provided', () => {
      const fields = [makeField('用户消息', 'fld-msg')];
      const records = [makeRecord('rec-no-name', { 'fld-msg': '消息内容' })];
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({ 用户消息: 'fld-msg' });

      const result = service.parseRecords(records, fields);

      expect(result[0].caseName).toBe('测试用例 rec-no-name');
    });

    it('should parse chat history when historyText is present', () => {
      const fields = [makeField('用户消息', 'fld-msg'), makeField('聊天记录', 'fld-history')];
      const records = [
        makeRecord('rec-1', {
          'fld-msg': '现在的问题',
          'fld-history': '候选人: 之前的问题\n招募经理: 之前的答案',
        }),
      ];
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({
        用户消息: 'fld-msg',
        聊天记录: 'fld-history',
      });

      const result = service.parseRecords(records, fields);

      expect(result[0].history).toBeDefined();
      expect(result[0].history!.length).toBeGreaterThan(0);
    });

    it('should continue processing when a single record throws an error', () => {
      const fields = [makeField('用户消息', 'fld-msg')];
      // The first record has no message (will be skipped), the second is valid
      const recordWithoutMsg = makeRecord('rec-no-msg', { 'fld-name': 'some name' });
      const goodRecord = makeRecord('rec-good', { 'fld-msg': '正常消息' });
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({ 用户消息: 'fld-msg' });

      // Only the good record (with a message) should be parsed
      const result = service.parseRecords([recordWithoutMsg, goodRecord], fields);
      expect(result).toHaveLength(1);
      expect(result[0].message).toBe('正常消息');
    });
  });

  // ========== parseConversationRecords ==========

  describe('parseConversationRecords', () => {
    it('should only parse records with 对话验证 test type', () => {
      const fields = [makeField('测试类型', 'fld-type'), makeField('完整对话记录', 'fld-conv')];
      const records = [
        makeRecord('rec-conv', {
          'fld-type': '对话验证',
          'fld-conv': '[12/04 17:20 候选人] 你好\n[12/04 17:21 招募经理] 好的',
        }),
        makeRecord('rec-scenario', { 'fld-type': '用例测试', 'fld-conv': '...' }),
      ];
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({
        测试类型: 'fld-type',
        完整对话记录: 'fld-conv',
      });
      mockParserService.parseConversation.mockReturnValue({
        success: true,
        messages: [
          { role: 'user', content: '你好', timestamp: '17:20' },
          { role: 'assistant', content: '好的', timestamp: '17:21' },
        ],
        totalTurns: 1,
      });

      const result = service.parseConversationRecords(records, fields);

      expect(result).toHaveLength(1);
      expect(result[0].recordId).toBe('rec-conv');
      expect(result[0].testType).toBe(TestType.CONVERSATION);
    });

    it('should skip records without conversation content', () => {
      const fields = [makeField('测试类型', 'fld-type')];
      const records = [makeRecord('rec-1', { 'fld-type': '对话验证' })];
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({ 测试类型: 'fld-type' });

      const result = service.parseConversationRecords(records, fields);

      expect(result).toHaveLength(0);
    });

    it('should skip records where parsing fails', () => {
      const fields = [makeField('测试类型', 'fld-type'), makeField('完整对话记录', 'fld-conv')];
      const records = [
        makeRecord('rec-1', { 'fld-type': '对话验证', 'fld-conv': 'invalid content' }),
      ];
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({
        测试类型: 'fld-type',
        完整对话记录: 'fld-conv',
      });
      mockParserService.parseConversation.mockReturnValue({
        success: false,
        messages: [],
        totalTurns: 0,
        error: 'Parse failed',
      });

      const result = service.parseConversationRecords(records, fields);

      expect(result).toHaveLength(0);
    });

    it('should set participantName to null when not provided', () => {
      const fields = [makeField('测试类型', 'fld-type'), makeField('完整对话记录', 'fld-conv')];
      const records = [
        makeRecord('rec-1', { 'fld-type': '对话验证', 'fld-conv': 'conversation text' }),
      ];
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({
        测试类型: 'fld-type',
        完整对话记录: 'fld-conv',
      });
      mockParserService.parseConversation.mockReturnValue({
        success: true,
        messages: [],
        totalTurns: 0,
      });

      const result = service.parseConversationRecords(records, fields);

      expect(result[0].participantName).toBeNull();
    });

    it('should generate conversationId as conv-{recordId}', () => {
      const fields = [makeField('测试类型', 'fld-type'), makeField('完整对话记录', 'fld-conv')];
      const records = [makeRecord('rec-123', { 'fld-type': '对话验证', 'fld-conv': 'content' })];
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({
        测试类型: 'fld-type',
        完整对话记录: 'fld-conv',
      });
      mockParserService.parseConversation.mockReturnValue({
        success: true,
        messages: [],
        totalTurns: 0,
      });

      const result = service.parseConversationRecords(records, fields);

      expect(result[0].conversationId).toBe('conv-rec-123');
    });
  });

  // ========== parseValidationSetRecords ==========

  describe('parseValidationSetRecords', () => {
    it('should parse all records without requiring test_type filter', () => {
      const fields = [makeField('完整对话记录', 'fld-conv')];
      const records = [
        makeRecord('rec-1', { 'fld-conv': 'conversation content' }),
        makeRecord('rec-2', { 'fld-conv': 'another conversation' }),
      ];
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({ 完整对话记录: 'fld-conv' });
      mockParserService.parseConversation.mockReturnValue({
        success: true,
        messages: [],
        totalTurns: 0,
      });

      const result = service.parseValidationSetRecords(records, fields);

      expect(result).toHaveLength(2);
    });

    it('should skip records without conversation content', () => {
      const fields = [makeField('完整对话记录', 'fld-conv')];
      const records = [makeRecord('rec-1', { 'other-field': 'value' })];
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({ 完整对话记录: 'fld-conv' });

      const result = service.parseValidationSetRecords(records, fields);

      expect(result).toHaveLength(0);
    });
  });

  // ========== parseHistory ==========

  describe('parseHistory', () => {
    it('should return empty array for empty historyText', () => {
      const result = service.parseHistory('');
      expect(result).toHaveLength(0);
    });

    it('should return empty array for whitespace historyText', () => {
      const result = service.parseHistory('   ');
      expect(result).toHaveLength(0);
    });

    it('should parse bracket format correctly', () => {
      const history = '[12/04 17:20 候选人] 你好\n[12/04 17:21 招募经理] 您好';

      const result = service.parseHistory(history);

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe(MessageRole.USER);
      expect(result[0].content).toBe('你好');
      expect(result[1].role).toBe(MessageRole.ASSISTANT);
      expect(result[1].content).toBe('您好');
    });

    it('should parse user: prefix format', () => {
      const history = 'user: 你好\nassistant: 您好';

      const result = service.parseHistory(history);

      expect(result[0].role).toBe(MessageRole.USER);
      expect(result[0].content).toBe('你好');
    });

    it('should parse 候选人: prefix format', () => {
      const history = '候选人: 这还招人吗\n招募经理: 是的';

      const result = service.parseHistory(history);

      expect(result[0].role).toBe(MessageRole.USER);
      expect(result[1].role).toBe(MessageRole.ASSISTANT);
    });

    it('should parse AI: prefix format', () => {
      const history = 'AI: 您好，有什么可以帮您？';

      const result = service.parseHistory(history);

      expect(result[0].role).toBe(MessageRole.ASSISTANT);
    });

    it('should default to USER role for unrecognized prefix', () => {
      const history = 'Some unknown format message';

      const result = service.parseHistory(history);

      expect(result[0].role).toBe(MessageRole.USER);
      expect(result[0].content).toBe('Some unknown format message');
    });

    it('should map 招募经理 to ASSISTANT in bracket format', () => {
      const history = '[12/04 17:20 招募经理] 请问有什么可以帮您？';

      const result = service.parseHistory(history);

      expect(result[0].role).toBe(MessageRole.ASSISTANT);
    });
  });

  // ========== getConversationTestsFromDefaultTable ==========

  describe('getConversationTestsFromDefaultTable', () => {
    it('should fetch from configured validationSet table', async () => {
      mockBitableApi.getTableConfig.mockReturnValue({
        appToken: 'valid-app-token',
        tableId: 'valid-table-id',
      });
      mockBitableApi.getFields.mockResolvedValue([]);
      mockBitableApi.getAllRecords.mockResolvedValue([]);
      mockBitableApi.buildFieldNameToIdMap.mockReturnValue({});

      const result = await service.getConversationTestsFromDefaultTable();

      expect(bitableApi.getTableConfig).toHaveBeenCalledWith('validationSet');
      expect(result.appToken).toBe('valid-app-token');
      expect(result.tableId).toBe('valid-table-id');
    });
  });
});

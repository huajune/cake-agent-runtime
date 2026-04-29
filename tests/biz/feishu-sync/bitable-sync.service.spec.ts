import { Test, TestingModule } from '@nestjs/testing';
import { FeishuBitableSyncService, AgentTestFeedback } from '@biz/feishu-sync/bitable-sync.service';
import { FeishuBitableApiService } from '@infra/feishu/services/bitable-api.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';

describe('FeishuBitableSyncService', () => {
  let service: FeishuBitableSyncService;
  let mockBitableApi: jest.Mocked<FeishuBitableApiService>;
  let mockMessageProcessingService: jest.Mocked<MessageProcessingService>;

  const chatTableConfig = { appToken: 'WXQgb98iPauYsHsSYzMckqHcnbb', tableId: 'tblKNwN8aquh2JAy' };
  const badcaseTableConfig = {
    appToken: 'WXQgb98iPauYsHsSYzMckqHcnbb',
    tableId: 'tbllFuw1BVwpvyrI',
  };

  beforeEach(async () => {
    mockBitableApi = {
      getTableConfig: jest.fn(),
      getFields: jest
        .fn()
        .mockResolvedValue([
          { field_name: '问题主键' },
          { field_name: '问题ID' },
          { field_name: '样本ID' },
          { field_name: '标题' },
          { field_name: '状态' },
          { field_name: '优先级' },
          { field_name: '来源' },
          { field_name: '亮点类型' },
          { field_name: '是否可复用' },
          { field_name: '候选人微信昵称' },
          { field_name: '招募经理姓名' },
          { field_name: '咨询时间' },
          { field_name: '聊天记录' },
          { field_name: '用户消息' },
          { field_name: '用例名称' },
          { field_name: '分类' },
          { field_name: '备注' },
          { field_name: 'chatId' },
          { field_name: 'message_id' },
          { field_name: 'traceId' },
          { field_name: 'SourceTrace' },
          { field_name: '来源MessageID' },
          { field_name: '处理流水ID' },
          { field_name: '来源TraceID' },
        ]),
      batchCreateRecords: jest.fn(),
      createRecord: jest.fn(),
      truncateText: jest.fn((text: string, max = 2000) =>
        text && text.length > max ? `${text.slice(0, max)}...(truncated)` : text || '',
      ),
    } as unknown as jest.Mocked<FeishuBitableApiService>;

    const getRecordsByTimestamps = jest.fn();
    mockMessageProcessingService = {
      getRecordsByTimestamps,
      getMessageProcessingRecords: getRecordsByTimestamps,
      getMessageProcessingRecordById: jest.fn().mockResolvedValue(null),
    } as unknown as jest.Mocked<MessageProcessingService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeishuBitableSyncService,
        { provide: FeishuBitableApiService, useValue: mockBitableApi },
        { provide: MessageProcessingService, useValue: mockMessageProcessingService },
      ],
    }).compile();

    service = module.get<FeishuBitableSyncService>(FeishuBitableSyncService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('syncYesterday', () => {
    it('should skip sync when chat config is incomplete (no appToken)', async () => {
      mockBitableApi.getTableConfig.mockReturnValue({ appToken: '', tableId: 'tbl_001' });

      await service.syncYesterday();

      expect(mockMessageProcessingService.getMessageProcessingRecords).not.toHaveBeenCalled();
    });

    it('should skip sync when chat config is incomplete (no tableId)', async () => {
      mockBitableApi.getTableConfig.mockReturnValue({ appToken: 'app_001', tableId: '' });

      await service.syncYesterday();

      expect(mockMessageProcessingService.getMessageProcessingRecords).not.toHaveBeenCalled();
    });

    it('should skip sync when no records found', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockMessageProcessingService.getMessageProcessingRecords.mockResolvedValue({
        records: [],
        total: 0,
      } as any);

      await service.syncYesterday();

      expect(mockBitableApi.batchCreateRecords).not.toHaveBeenCalled();
    });

    it('should sync records within yesterday time window', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);

      // Create a record that falls in yesterday's window
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(12, 0, 0, 0);

      const records = [
        {
          messageId: 'msg_001',
          userId: 'user_001',
          userName: '张三',
          managerName: '李经理',
          receivedAt: yesterday.getTime(),
          messagePreview: '你好',
          replyPreview: '您好！',
        },
      ];

      mockMessageProcessingService.getMessageProcessingRecords.mockResolvedValue({
        records,
        total: 1,
      } as any);
      mockBitableApi.batchCreateRecords.mockResolvedValue({ created: 1, failed: 0 });

      await service.syncYesterday();

      expect(mockBitableApi.batchCreateRecords).toHaveBeenCalled();
    });

    it('should skip records outside yesterday window', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);

      // Record from 2 days ago - outside yesterday's window
      const twoDaysAgo = new Date();
      twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
      twoDaysAgo.setHours(12, 0, 0, 0);

      const records = [
        {
          messageId: 'msg_001',
          userId: 'user_001',
          userName: '张三',
          receivedAt: twoDaysAgo.getTime(),
          messagePreview: '你好',
          replyPreview: '您好！',
        },
      ];

      mockMessageProcessingService.getMessageProcessingRecords.mockResolvedValue({
        records,
        total: 1,
      } as any);

      await service.syncYesterday();

      expect(mockBitableApi.batchCreateRecords).not.toHaveBeenCalled();
    });

    it('should propagate error from getMessageProcessingRecords (not caught by syncYesterday)', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockMessageProcessingService.getMessageProcessingRecords.mockRejectedValue(
        new Error('DB error'),
      );

      // syncYesterday does not catch errors from getMessageProcessingRecords
      await expect(service.syncYesterday()).rejects.toThrow('DB error');
    });
  });

  describe('writeAgentTestFeedback', () => {
    it('should write badcase feedback successfully', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(badcaseTableConfig);
      mockBitableApi.createRecord.mockResolvedValue({ recordId: 'rec_new' });

      const feedback: AgentTestFeedback = {
        type: 'badcase',
        chatHistory: '用户: 你好\nAgent: 您好！',
        userMessage: '你好',
        errorType: '信息错误',
        remark: '薪资数据不准确',
        chatId: 'chat_001',
        messageId: 'msg_001',
        traceId: 'trace_001',
      };

      const result = await service.writeAgentTestFeedback(feedback);

      expect(result.success).toBe(true);
      expect(result.recordId).toBe('rec_new');
      expect(mockBitableApi.createRecord).toHaveBeenCalledWith(
        badcaseTableConfig.appToken,
        badcaseTableConfig.tableId,
        expect.objectContaining({
          问题主键: expect.any(String),
          标题: '薪资数据不准确',
          状态: '待分析',
          优先级: 'P2',
          来源: 'AgentTest',
          分类: '信息错误',
          chatId: 'chat_001',
          message_id: 'msg_001',
          traceId: 'trace_001',
        }),
      );
    });

    it('should enrich feedback source trace from message processing detail', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(badcaseTableConfig);
      mockBitableApi.createRecord.mockResolvedValue({ recordId: 'rec_new' });
      mockMessageProcessingService.getMessageProcessingRecordById.mockResolvedValue({
        messageId: 'msg_anchor',
        chatId: 'chat_trace',
        userId: 'user_001',
        userName: '候选人',
        managerName: '经理',
        receivedAt: 1777269690302,
        messagePreview: '想找附近门店',
        replyPreview: '我帮你看看',
        status: 'success',
        batchId: 'batch_001',
        memorySnapshot: {
          currentStage: 'trust_building',
          presentedJobIds: [527548],
          recommendedJobIds: [527548, 527549],
          sessionFacts: { region: '松江' },
          profileKeys: ['age'],
        },
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: { regionNameList: ['松江'] },
            resultCount: 2,
            status: 'ok',
          },
        ],
        agentInvocation: {
          request: { modelId: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
          response: { traceId: 'trace_from_record', finishReason: 'stop' },
          isFallback: false,
        },
      } as any);

      const result = await service.writeAgentTestFeedback({
        type: 'badcase',
        chatHistory: '用户: 想找附近门店',
        userMessage: '想找附近门店',
        chatId: 'chat_trace',
        messageId: 'msg_anchor',
        sourceTrace: {
          badcaseIds: ['bad_001'],
          badcaseRecordIds: ['rec_bad_001'],
        },
      });

      expect(result.success).toBe(true);
      const fields = mockBitableApi.createRecord.mock.calls[0][2];
      expect(fields.SourceTrace).toContain('"badcaseIds"');
      expect(fields.SourceTrace).toContain('"trace_from_record"');
      expect(fields['来源MessageID']).toBe('msg_anchor');
      expect(fields['处理流水ID']).toBe('msg_anchor');
      expect(fields['来源TraceID']).toBe('trace_from_record');
    });

    it('should return failure when config is incomplete', async () => {
      mockBitableApi.getTableConfig.mockReturnValue({ appToken: '', tableId: '' });

      const feedback: AgentTestFeedback = {
        type: 'badcase',
        chatHistory: '用户: 你好\nAgent: 您好！',
      };

      const result = await service.writeAgentTestFeedback(feedback);

      expect(result.success).toBe(false);
      expect(result.error).toContain('badcase 表配置不完整');
    });

    it('should return failure when createRecord throws', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(badcaseTableConfig);
      mockBitableApi.createRecord.mockRejectedValue(new Error('API error'));

      const feedback: AgentTestFeedback = {
        type: 'badcase',
        chatHistory: 'some chat history',
      };

      const result = await service.writeAgentTestFeedback(feedback);

      expect(result.success).toBe(false);
      expect(result.error).toBe('API error');
    });

    it('should include optional fields when provided', async () => {
      const goodcaseConfig = {
        appToken: 'WXQgb98iPauYsHsSYzMckqHcnbb',
        tableId: 'tblmI0UBzhknkIOm',
      };
      mockBitableApi.getTableConfig.mockReturnValue(goodcaseConfig);
      mockBitableApi.getFields.mockResolvedValueOnce([
        { field_name: '样本主键' },
        { field_name: '样本ID' },
        { field_name: '标题' },
        { field_name: '候选人微信昵称' },
        { field_name: '招募经理姓名' },
        { field_name: '咨询时间' },
        { field_name: '聊天记录' },
        { field_name: '用户消息' },
        { field_name: '用例名称' },
        { field_name: '备注' },
        { field_name: '来源' },
        { field_name: '亮点类型' },
        { field_name: '是否可复用' },
        { field_name: '是否纳入验证集' },
      ] as any);
      mockBitableApi.createRecord.mockResolvedValue({ recordId: 'rec_good' });

      const feedback: AgentTestFeedback = {
        type: 'goodcase',
        chatHistory: 'Good conversation',
        userMessage: '我想找工作',
        chatId: 'chat_002',
        remark: '回复质量很好',
        candidateName: '真实候选人',
        managerName: '真实经理',
      };

      await service.writeAgentTestFeedback(feedback);

      const callArgs = mockBitableApi.createRecord.mock.calls[0];
      const fields = callArgs[2];
      expect(fields['样本主键']).toBe(fields['样本ID']);
      expect(fields['用户消息']).toBeDefined();
      expect(fields.chatId).toBeUndefined();
      expect(fields['备注']).toContain('回复质量很好\nchatId: chat_002');
      expect(fields['备注']).toContain('sourceChatIds: chat_002');
      expect(fields['备注']).toContain('SourceTrace:');
      expect(fields['候选人微信昵称']).toBe('真实候选人');
      expect(fields['招募经理姓名']).toBe('真实经理');
      expect(fields['来源']).toBe('AgentTest');
      expect(fields['亮点类型']).toBe('其他');
      expect(fields['是否可复用']).toBe(true);
    });

    it('should generate a random case ID and issue ID', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(badcaseTableConfig);
      mockBitableApi.createRecord.mockResolvedValue({ recordId: 'rec_001' });

      const feedback: AgentTestFeedback = {
        type: 'badcase',
        chatHistory: 'Some history',
      };

      await service.writeAgentTestFeedback(feedback);

      const callArgs = mockBitableApi.createRecord.mock.calls[0];
      const fields = callArgs[2];
      expect(fields['用例名称']).toBeDefined();
      expect(fields['问题ID']).toBeDefined();
      expect(typeof fields['用例名称']).toBe('string');
      expect((fields['用例名称'] as string).length).toBeGreaterThan(0);
      expect(fields['用例名称']).toBe(fields['问题ID']);
    });
  });
});

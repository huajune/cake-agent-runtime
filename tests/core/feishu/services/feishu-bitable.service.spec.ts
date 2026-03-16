import { Test, TestingModule } from '@nestjs/testing';
import { FeishuBitableSyncService, AgentTestFeedback } from '@core/feishu/services/feishu-bitable.service';
import { FeishuBitableApiService } from '@core/feishu/services/feishu-bitable-api.service';
import { MessageProcessingRepository } from '@biz/message/repositories/message-processing.repository';

describe('FeishuBitableSyncService', () => {
  let service: FeishuBitableSyncService;
  let mockBitableApi: jest.Mocked<FeishuBitableApiService>;
  let mockRepository: jest.Mocked<MessageProcessingRepository>;

  const chatTableConfig = { appToken: 'WXQgb98iPauYsHsSYzMckqHcnbb', tableId: 'tblKNwN8aquh2JAy' };
  const badcaseTableConfig = {
    appToken: 'WXQgb98iPauYsHsSYzMckqHcnbb',
    tableId: 'tbllFuw1BVwpvyrI',
  };

  beforeEach(async () => {
    mockBitableApi = {
      getTableConfig: jest.fn(),
      batchCreateRecords: jest.fn(),
      createRecord: jest.fn(),
      truncateText: jest.fn((text: string, max = 2000) =>
        text && text.length > max ? `${text.slice(0, max)}...(truncated)` : text || '',
      ),
    } as unknown as jest.Mocked<FeishuBitableApiService>;

    mockRepository = {
      getMessageProcessingRecords: jest.fn(),
    } as unknown as jest.Mocked<MessageProcessingRepository>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeishuBitableSyncService,
        { provide: FeishuBitableApiService, useValue: mockBitableApi },
        { provide: MessageProcessingRepository, useValue: mockRepository },
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

      expect(mockRepository.getMessageProcessingRecords).not.toHaveBeenCalled();
    });

    it('should skip sync when chat config is incomplete (no tableId)', async () => {
      mockBitableApi.getTableConfig.mockReturnValue({ appToken: 'app_001', tableId: '' });

      await service.syncYesterday();

      expect(mockRepository.getMessageProcessingRecords).not.toHaveBeenCalled();
    });

    it('should skip sync when no records found', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockRepository.getMessageProcessingRecords.mockResolvedValue({
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

      mockRepository.getMessageProcessingRecords.mockResolvedValue({
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

      mockRepository.getMessageProcessingRecords.mockResolvedValue({
        records,
        total: 1,
      } as any);

      await service.syncYesterday();

      expect(mockBitableApi.batchCreateRecords).not.toHaveBeenCalled();
    });

    it('should propagate error from getMessageProcessingRecords (not caught by syncYesterday)', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockRepository.getMessageProcessingRecords.mockRejectedValue(new Error('DB error'));

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
      };

      const result = await service.writeAgentTestFeedback(feedback);

      expect(result.success).toBe(true);
      expect(result.recordId).toBe('rec_new');
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
      mockBitableApi.createRecord.mockResolvedValue({ recordId: 'rec_good' });

      const feedback: AgentTestFeedback = {
        type: 'goodcase',
        chatHistory: 'Good conversation',
        userMessage: '我想找工作',
        chatId: 'chat_002',
        remark: '回复质量很好',
      };

      await service.writeAgentTestFeedback(feedback);

      const callArgs = mockBitableApi.createRecord.mock.calls[0];
      const fields = callArgs[2];
      expect(fields['用户消息']).toBeDefined();
      expect(fields.chatId).toBe('chat_002');
      expect(fields['备注']).toBe('回复质量很好');
    });

    it('should generate a random case ID', async () => {
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
      expect(typeof fields['用例名称']).toBe('string');
      expect((fields['用例名称'] as string).length).toBeGreaterThan(0);
    });
  });
});

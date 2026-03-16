import { Test, TestingModule } from '@nestjs/testing';
import { ChatRecordSyncService } from '@core/feishu/services/feishu-chat-record.service';
import { FeishuBitableApiService } from '@core/feishu/services/feishu-bitable-api.service';
import { ChatMessageRepository } from '@biz/message/repositories/chat-message.repository';

describe('ChatRecordSyncService', () => {
  let service: ChatRecordSyncService;
  let mockBitableApi: jest.Mocked<FeishuBitableApiService>;
  let mockChatMessageRepository: jest.Mocked<ChatMessageRepository>;

  const chatTableConfig = { appToken: 'WXQgb98iPauYsHsSYzMckqHcnbb', tableId: 'tblKNwN8aquh2JAy' };

  beforeEach(async () => {
    mockBitableApi = {
      getTableConfig: jest.fn(),
      getAllRecords: jest.fn(),
      batchCreateRecords: jest.fn(),
      truncateText: jest.fn((text: string, max = 2000) =>
        text && text.length > max ? `${text.slice(0, max)}...(truncated)` : text || '',
      ),
    } as unknown as jest.Mocked<FeishuBitableApiService>;

    mockChatMessageRepository = {
      getChatMessagesByTimeRange: jest.fn(),
    } as unknown as jest.Mocked<ChatMessageRepository>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatRecordSyncService,
        { provide: FeishuBitableApiService, useValue: mockBitableApi },
        { provide: ChatMessageRepository, useValue: mockChatMessageRepository },
      ],
    }).compile();

    service = module.get<ChatRecordSyncService>(ChatRecordSyncService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const buildMessages = (chatId = 'chat_001') => [
    {
      role: 'user' as const,
      content: '你好，我想找工作',
      timestamp: Date.now() - 3600000,
      messageId: 'msg_001',
      chatId,
      candidateName: '张三',
      managerName: '李经理',
    },
    {
      role: 'assistant' as const,
      content: '您好！很高兴为您服务',
      timestamp: Date.now() - 3500000,
      messageId: 'msg_002',
      chatId,
    },
  ];

  describe('syncYesterdayChatRecords', () => {
    it('should skip sync when chat config is incomplete (no appToken)', async () => {
      mockBitableApi.getTableConfig.mockReturnValue({ appToken: '', tableId: 'tbl_001' });

      await service.syncYesterdayChatRecords();

      expect(mockChatMessageRepository.getChatMessagesByTimeRange).not.toHaveBeenCalled();
    });

    it('should skip sync when chat config is incomplete (no tableId)', async () => {
      mockBitableApi.getTableConfig.mockReturnValue({ appToken: 'app_001', tableId: '' });

      await service.syncYesterdayChatRecords();

      expect(mockChatMessageRepository.getChatMessagesByTimeRange).not.toHaveBeenCalled();
    });

    it('should skip sync when no chat records found', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockChatMessageRepository.getChatMessagesByTimeRange.mockResolvedValue([]);

      await service.syncYesterdayChatRecords();

      expect(mockBitableApi.batchCreateRecords).not.toHaveBeenCalled();
    });

    it('should sync chat records successfully', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockChatMessageRepository.getChatMessagesByTimeRange.mockResolvedValue([
        { chatId: 'chat_001', messages: buildMessages() },
      ]);
      mockBitableApi.getAllRecords.mockResolvedValue([]);
      mockBitableApi.batchCreateRecords.mockResolvedValue({ created: 1, failed: 0 });

      await service.syncYesterdayChatRecords();

      expect(mockBitableApi.batchCreateRecords).toHaveBeenCalled();
    });

    it('should deduplicate records that already exist in feishu', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockChatMessageRepository.getChatMessagesByTimeRange.mockResolvedValue([
        { chatId: 'chat_existing', messages: buildMessages('chat_existing') },
        { chatId: 'chat_new', messages: buildMessages('chat_new') },
      ]);
      // chat_existing already in feishu
      mockBitableApi.getAllRecords.mockResolvedValue([
        { record_id: 'rec_001', fields: { chatId: 'chat_existing' } },
      ]);
      mockBitableApi.batchCreateRecords.mockResolvedValue({ created: 1, failed: 0 });

      await service.syncYesterdayChatRecords();

      const createCall = mockBitableApi.batchCreateRecords.mock.calls[0];
      const records = createCall[2] as Array<{ fields: Record<string, unknown> }>;
      // Should only include chat_new
      expect(records).toHaveLength(1);
      expect(records[0].fields.chatId).toBe('chat_new');
    });

    it('should skip write when all records already exist', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockChatMessageRepository.getChatMessagesByTimeRange.mockResolvedValue([
        { chatId: 'chat_001', messages: buildMessages() },
      ]);
      mockBitableApi.getAllRecords.mockResolvedValue([
        { record_id: 'rec_001', fields: { chatId: 'chat_001' } },
      ]);

      await service.syncYesterdayChatRecords();

      expect(mockBitableApi.batchCreateRecords).not.toHaveBeenCalled();
    });

    it('should handle sync failure gracefully', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockChatMessageRepository.getChatMessagesByTimeRange.mockRejectedValue(new Error('DB error'));

      // Should not throw
      await expect(service.syncYesterdayChatRecords()).resolves.toBeUndefined();
    });

    it('should continue when getExistingChatIds fails (skip deduplication)', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockChatMessageRepository.getChatMessagesByTimeRange.mockResolvedValue([
        { chatId: 'chat_001', messages: buildMessages() },
      ]);
      mockBitableApi.getAllRecords.mockRejectedValue(new Error('API error'));
      mockBitableApi.batchCreateRecords.mockResolvedValue({ created: 1, failed: 0 });

      // Should not throw and should still call batchCreate
      await service.syncYesterdayChatRecords();

      expect(mockBitableApi.batchCreateRecords).toHaveBeenCalled();
    });
  });

  describe('manualSync', () => {
    it('should return success message after sync', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockChatMessageRepository.getChatMessagesByTimeRange.mockResolvedValue([]);

      const result = await service.manualSync();

      expect(result.success).toBe(true);
      expect(result.message).toBe('手动同步完成');
    });

    it('should return failure when sync throws', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      // Simulate a non-catchable error from within syncYesterdayChatRecords
      jest.spyOn(service, 'syncYesterdayChatRecords').mockRejectedValue(new Error('Sync failed'));

      const result = await service.manualSync();

      expect(result.success).toBe(false);
      expect(result.message).toContain('同步失败');
    });
  });

  describe('syncByTimeRange', () => {
    const startTime = new Date('2026-03-01T00:00:00Z').getTime();
    const endTime = new Date('2026-03-02T00:00:00Z').getTime();

    it('should return failure when config is incomplete', async () => {
      mockBitableApi.getTableConfig.mockReturnValue({ appToken: '', tableId: '' });

      const result = await service.syncByTimeRange(startTime, endTime);

      expect(result.success).toBe(false);
      expect(result.message).toContain('未配置完整');
    });

    it('should return success with recordCount 0 when no data', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockChatMessageRepository.getChatMessagesByTimeRange.mockResolvedValue([]);

      const result = await service.syncByTimeRange(startTime, endTime);

      expect(result.success).toBe(true);
      expect(result.recordCount).toBe(0);
    });

    it('should sync records in time range', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockChatMessageRepository.getChatMessagesByTimeRange.mockResolvedValue([
        { chatId: 'chat_001', messages: buildMessages() },
      ]);
      mockBitableApi.getAllRecords.mockResolvedValue([]);
      mockBitableApi.batchCreateRecords.mockResolvedValue({ created: 1, failed: 0 });

      const result = await service.syncByTimeRange(startTime, endTime);

      expect(result.success).toBe(true);
      expect(result.recordCount).toBe(1);
    });

    it('should return success when all records already exist', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockChatMessageRepository.getChatMessagesByTimeRange.mockResolvedValue([
        { chatId: 'chat_001', messages: buildMessages() },
      ]);
      mockBitableApi.getAllRecords.mockResolvedValue([
        { record_id: 'rec_001', fields: { chatId: 'chat_001' } },
      ]);

      const result = await service.syncByTimeRange(startTime, endTime);

      expect(result.success).toBe(true);
      expect(result.message).toBe('所有记录均已存在');
    });

    it('should handle errors and return failure', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockChatMessageRepository.getChatMessagesByTimeRange.mockRejectedValue(
        new Error('DB connection failed'),
      );

      const result = await service.syncByTimeRange(startTime, endTime);

      expect(result.success).toBe(false);
      expect(result.message).toContain('同步失败');
    });

    it('should pass correct time range to repository', async () => {
      mockBitableApi.getTableConfig.mockReturnValue(chatTableConfig);
      mockChatMessageRepository.getChatMessagesByTimeRange.mockResolvedValue([]);

      await service.syncByTimeRange(startTime, endTime);

      expect(mockChatMessageRepository.getChatMessagesByTimeRange).toHaveBeenCalledWith(
        startTime,
        endTime,
      );
    });
  });
});

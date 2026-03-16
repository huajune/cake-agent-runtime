import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MessageHistoryService } from '@wecom/message/services/message-history.service';
import { ChatMessageRepository } from '@biz/message/repositories/chat-message.repository';

describe('MessageHistoryService', () => {
  let service: MessageHistoryService;

  const mockChatMessageRepository = {
    getChatHistory: jest.fn(),
    getChatHistoryDetail: jest.fn(),
    saveChatMessage: jest.fn(),
    saveChatMessagesBatch: jest.fn(),
    getAllChatIds: jest.fn(),
    getChatMessagesByTimeRange: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue?: string) => {
      if (key === 'MAX_HISTORY_PER_CHAT') return '60';
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageHistoryService,
        { provide: ChatMessageRepository, useValue: mockChatMessageRepository },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<MessageHistoryService>(MessageHistoryService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getHistory', () => {
    it('should return history messages from repository', async () => {
      const mockMessages = [
        { role: 'user', content: 'Hello', timestamp: 1000000 },
        { role: 'assistant', content: 'Hi there!', timestamp: 1000001 },
      ];
      mockChatMessageRepository.getChatHistory.mockResolvedValue(mockMessages);

      const result = await service.getHistory('chat-123');

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('assistant');
      expect(mockChatMessageRepository.getChatHistory).toHaveBeenCalledWith('chat-123', 60);
    });

    it('should return empty array when repository throws error', async () => {
      mockChatMessageRepository.getChatHistory.mockRejectedValue(new Error('DB connection failed'));

      const result = await service.getHistory('chat-error');

      expect(result).toEqual([]);
    });
  });

  describe('getHistoryForContext', () => {
    it('should return history without exclude when no messageId given', async () => {
      const mockHistory = [
        { role: 'user', content: 'Message 1', timestamp: 1000 },
        { role: 'assistant', content: 'Reply 1', timestamp: 1001 },
      ];
      mockChatMessageRepository.getChatHistory.mockResolvedValue(mockHistory);

      const result = await service.getHistoryForContext('chat-123');

      expect(result).toHaveLength(2);
      expect(mockChatMessageRepository.getChatHistory).toHaveBeenCalledWith('chat-123', 61); // maxHistory + 1
    });

    it('should exclude specified messageId when provided', async () => {
      const mockHistory = [
        { role: 'user', content: 'Message 1', timestamp: 1000 },
        { role: 'assistant', content: 'Reply 1', timestamp: 1001 },
      ];
      const mockDetail = [
        { role: 'user', content: 'Message 1', timestamp: 1000, messageId: 'msg-100' },
        { role: 'user', content: 'Message 2', timestamp: 1002, messageId: 'msg-to-exclude' },
        { role: 'assistant', content: 'Reply 1', timestamp: 1003, messageId: 'msg-102' },
      ];
      mockChatMessageRepository.getChatHistory.mockResolvedValue(mockHistory);
      mockChatMessageRepository.getChatHistoryDetail.mockResolvedValue(mockDetail);

      const result = await service.getHistoryForContext('chat-123', 'msg-to-exclude');

      expect(result).toHaveLength(2);
      expect(result.every((m) => m.content !== 'Message 2')).toBe(true);
    });

    it('should return empty array on error', async () => {
      mockChatMessageRepository.getChatHistory.mockRejectedValue(new Error('DB error'));

      const result = await service.getHistoryForContext('chat-err');

      expect(result).toEqual([]);
    });
  });

  describe('addMessageToHistory', () => {
    it('should save message to repository with full metadata', async () => {
      mockChatMessageRepository.saveChatMessage.mockResolvedValue(undefined);

      await service.addMessageToHistory('chat-123', 'user', 'Hello', {
        messageId: 'msg-123',
        candidateName: 'Alice',
        managerName: 'Bob',
        orgId: 'org-123',
        botId: 'bot-123',
        messageType: 7,
        source: 0,
        isRoom: false,
        imBotId: 'wxid-bot',
        imContactId: 'wxid-contact',
        contactType: 1,
        isSelf: false,
      });

      expect(mockChatMessageRepository.saveChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-123',
          messageId: 'msg-123',
          role: 'user',
          content: 'Hello',
          candidateName: 'Alice',
          managerName: 'Bob',
        }),
      );
    });

    it('should generate messageId when not provided', async () => {
      mockChatMessageRepository.saveChatMessage.mockResolvedValue(undefined);

      await service.addMessageToHistory('chat-123', 'assistant', 'Hi!');

      expect(mockChatMessageRepository.saveChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-123',
          role: 'assistant',
          content: 'Hi!',
          messageId: expect.stringMatching(/^msg_\d+_/),
        }),
      );
    });

    it('should handle save error gracefully without throwing', async () => {
      mockChatMessageRepository.saveChatMessage.mockRejectedValue(new Error('DB save failed'));

      await expect(service.addMessageToHistory('chat-123', 'user', 'Hello')).resolves.not.toThrow();
    });
  });

  describe('clearHistory', () => {
    it('should return 0 and log warning for specific chatId', async () => {
      const result = await service.clearHistory('chat-123');
      expect(result).toBe(0);
    });

    it('should return 0 and log warning when no chatId given', async () => {
      const result = await service.clearHistory();
      expect(result).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return stats object with supabase storage type', () => {
      const stats = service.getStats();

      expect(stats).toMatchObject({
        storageType: 'supabase',
        maxMessagesForContext: 60,
        retention: 'permanent',
      });
    });
  });

  describe('getHistoryDetail', () => {
    it('should return chat history detail with messages', async () => {
      const mockMessages = [
        {
          role: 'user',
          content: 'Hello',
          timestamp: 1000,
          messageId: 'msg-1',
          candidateName: 'Alice',
          managerName: 'Bob',
        },
        {
          role: 'assistant',
          content: 'Hi!',
          timestamp: 1001,
          messageId: 'msg-2',
          candidateName: undefined,
          managerName: undefined,
        },
      ];
      mockChatMessageRepository.getChatHistoryDetail.mockResolvedValue(mockMessages);

      const result = await service.getHistoryDetail('chat-123');

      expect(result).not.toBeNull();
      expect(result!.chatId).toBe('chat-123');
      expect(result!.messages).toHaveLength(2);
      expect(result!.messageCount).toBe(2);
    });

    it('should return null when no messages found', async () => {
      mockChatMessageRepository.getChatHistoryDetail.mockResolvedValue([]);

      const result = await service.getHistoryDetail('empty-chat');

      expect(result).toBeNull();
    });

    it('should return null on error', async () => {
      mockChatMessageRepository.getChatHistoryDetail.mockRejectedValue(new Error('DB error'));

      const result = await service.getHistoryDetail('error-chat');

      expect(result).toBeNull();
    });
  });

  describe('getAllChatIds', () => {
    it('should return all chat IDs from repository', async () => {
      const mockChatIds = ['chat-1', 'chat-2', 'chat-3'];
      mockChatMessageRepository.getAllChatIds.mockResolvedValue(mockChatIds);

      const result = await service.getAllChatIds();

      expect(result).toEqual(mockChatIds);
    });

    it('should return empty array on error', async () => {
      mockChatMessageRepository.getAllChatIds.mockRejectedValue(new Error('DB error'));

      const result = await service.getAllChatIds();

      expect(result).toEqual([]);
    });
  });

  describe('getChatRecordsByTimeRange', () => {
    it('should return chat records within time range', async () => {
      const mockRecords = [
        {
          chatId: 'chat-1',
          messages: [
            {
              role: 'user',
              content: 'Hello',
              timestamp: 1000,
              messageId: 'msg-1',
              candidateName: 'Alice',
              managerName: 'Bob',
            },
          ],
        },
      ];
      mockChatMessageRepository.getChatMessagesByTimeRange.mockResolvedValue(mockRecords);

      const result = await service.getChatRecordsByTimeRange(900, 1100);

      expect(result).toHaveLength(1);
      expect(result[0].chatId).toBe('chat-1');
      expect(result[0].messages).toHaveLength(1);
    });

    it('should return empty array on error', async () => {
      mockChatMessageRepository.getChatMessagesByTimeRange.mockRejectedValue(new Error('DB error'));

      const result = await service.getChatRecordsByTimeRange(0, 1000);

      expect(result).toEqual([]);
    });
  });

  describe('addMessagesToHistoryBatch', () => {
    it('should batch save messages and return count', async () => {
      mockChatMessageRepository.saveChatMessagesBatch.mockResolvedValue(3);

      const messages = [
        { chatId: 'chat-1', role: 'user' as const, content: 'Msg 1' },
        { chatId: 'chat-2', role: 'user' as const, content: 'Msg 2' },
        { chatId: 'chat-1', role: 'assistant' as const, content: 'Reply 1' },
      ];

      const result = await service.addMessagesToHistoryBatch(messages);

      expect(result).toBe(3);
      expect(mockChatMessageRepository.saveChatMessagesBatch).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ chatId: 'chat-1', content: 'Msg 1' })]),
      );
    });

    it('should return 0 when messages array is empty', async () => {
      const result = await service.addMessagesToHistoryBatch([]);

      expect(result).toBe(0);
      expect(mockChatMessageRepository.saveChatMessagesBatch).not.toHaveBeenCalled();
    });

    it('should return 0 on batch save error', async () => {
      mockChatMessageRepository.saveChatMessagesBatch.mockRejectedValue(new Error('DB error'));

      const messages = [{ chatId: 'chat-1', role: 'user' as const, content: 'Msg 1' }];
      const result = await service.addMessagesToHistoryBatch(messages);

      expect(result).toBe(0);
    });
  });
});

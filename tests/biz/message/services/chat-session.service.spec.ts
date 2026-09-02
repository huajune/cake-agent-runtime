import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ChatMessageRepository } from '@biz/message/repositories/chat-message.repository';
import { RedisService } from '@infra/redis/redis.service';
import { buildChatHistoryCacheKey } from '@memory/short-term/chat-history-cache.util';
import { MEMORY_SESSION_TTL_DAYS_DEFAULT } from '@memory/memory.config';
import { MessageSource, MessageType } from '@enums/message-callback.enum';
import { StorageMessageSource, StorageMessageType } from '@enums/storage-message.enum';

describe('ChatSessionService', () => {
  let service: ChatSessionService;

  const mockChatMessageRepository = {
    getTodayChatMessages: jest.fn(),
    getChatSessionPage: jest.fn(),
    getChatSessionList: jest.fn(),
    getChatDailyStats: jest.fn(),
    getChatSummaryStats: jest.fn(),
    getChatSessionListOptimized: jest.fn(),
    getChatHistoryDetail: jest.fn(),
    getChatHistory: jest.fn(),
    saveChatMessage: jest.fn(),
    saveChatMessagesBatch: jest.fn(),
    updateContentByMessageId: jest.fn(),
    getChatMessagesByTimeRange: jest.fn(),
    cleanupChatMessages: jest.fn(),
  };

  const mockRedisService = {
    exists: jest.fn(),
    rpush: jest.fn(),
    ltrim: jest.fn(),
    expire: jest.fn(),
    setex: jest.fn(),
    get: jest.fn(),
    lrange: jest.fn(),
    del: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      if (key === 'MAX_HISTORY_PER_CHAT') return '60';
      if (key === 'MEMORY_SESSION_TTL_DAYS') return '1';
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatSessionService,
        { provide: ChatMessageRepository, useValue: mockChatMessageRepository },
        { provide: RedisService, useValue: mockRedisService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<ChatSessionService>(ChatSessionService);

    jest.clearAllMocks();
  });

  describe('short-term cache mirroring', () => {
    it('should append saved message into redis short-term cache when DB truly inserted a new row', async () => {
      mockChatMessageRepository.saveChatMessage.mockResolvedValue({ inserted: true });

      const ok = await service.saveMessage({
        chatId: 'chat-1',
        messageId: 'msg-1',
        role: 'assistant',
        content: '你好',
        timestamp: 1710900000000,
        contactType: 1,
        source: MessageSource.AGGREGATED_CHAT_MANUAL,
        messageType: MessageType.TEXT,
        isSelf: true,
        payload: { source: 'callback' },
      });

      expect(ok).toBe(true);
      expect(mockRedisService.rpush).toHaveBeenCalledWith(
        buildChatHistoryCacheKey('chat-1'),
        expect.any(String),
      );
      expect(mockRedisService.ltrim).toHaveBeenCalledWith(
        buildChatHistoryCacheKey('chat-1'),
        -60,
        -1,
      );
      expect(mockRedisService.expire).toHaveBeenCalledWith(
        buildChatHistoryCacheKey('chat-1'),
        86400,
      );
      const cached = JSON.parse(mockRedisService.rpush.mock.calls[0][1] as string);
      expect(cached).toMatchObject({
        role: 'assistant',
        source: StorageMessageSource.AGGREGATED_CHAT_MANUAL,
        messageType: StorageMessageType.TEXT,
        isSelf: true,
        payloadSource: 'callback',
        provenanceVersion: 2,
      });
      // Index key is gone — dedup delegated to DB UNIQUE(message_id)
      expect(mockRedisService.setex).not.toHaveBeenCalled();
      expect(mockRedisService.exists).not.toHaveBeenCalled();
    });

    it('should fall back to the shared memory-side default TTL when env is not set', async () => {
      // 回归锁：短期 list 缓存的 TTL 默认值必须与 MemoryConfig.sessionTtl 同源，
      // 两条续期路径默认值漂移会让缓存生命周期取决于最后一次写来自哪条路径。
      const module = await Test.createTestingModule({
        providers: [
          ChatSessionService,
          { provide: ChatMessageRepository, useValue: mockChatMessageRepository },
          { provide: RedisService, useValue: mockRedisService },
          {
            provide: ConfigService,
            useValue: { get: jest.fn((_key: string, defaultValue?: string) => defaultValue) },
          },
        ],
      }).compile();
      const svc = module.get<ChatSessionService>(ChatSessionService);
      mockChatMessageRepository.saveChatMessage.mockResolvedValue({ inserted: true });

      await svc.saveMessage({
        chatId: 'chat-1',
        messageId: 'msg-default-ttl',
        role: 'assistant',
        content: '你好',
        timestamp: 1710900000000,
        contactType: 1,
        source: MessageSource.AGGREGATED_CHAT_MANUAL,
        messageType: MessageType.TEXT,
        isSelf: true,
      });

      expect(mockRedisService.expire).toHaveBeenCalledWith(
        buildChatHistoryCacheKey('chat-1'),
        parseInt(MEMORY_SESSION_TTL_DAYS_DEFAULT, 10) * 24 * 60 * 60,
      );
    });

    it('should skip cache mirror when DB reports the row already existed (UNIQUE conflict)', async () => {
      mockChatMessageRepository.saveChatMessage.mockResolvedValue({ inserted: false });

      const ok = await service.saveMessage({
        chatId: 'chat-1',
        messageId: 'msg-1',
        role: 'user',
        content: '你好',
        timestamp: 1710900000000,
        contactType: 1,
      });

      expect(ok).toBe(false);
      expect(mockRedisService.rpush).not.toHaveBeenCalled();
    });

    it('should invalidate cached list when message content is updated', async () => {
      mockChatMessageRepository.updateContentByMessageId.mockResolvedValue({ chatId: 'chat-1' });
      mockRedisService.del.mockResolvedValue(1);

      const ok = await service.updateMessageContent('msg-1', '[图片消息] 这是招聘海报');

      expect(ok).toBe(true);
      // 直接作废 list，下次读取 cache miss 触发 DB backfill
      expect(mockRedisService.del).toHaveBeenCalledWith(buildChatHistoryCacheKey('chat-1'));
      expect(mockRedisService.lrange).not.toHaveBeenCalled();
      expect(mockRedisService.rpush).not.toHaveBeenCalled();
    });

    it('should not touch redis when messageId does not exist in DB', async () => {
      mockChatMessageRepository.updateContentByMessageId.mockResolvedValue({ chatId: null });

      const ok = await service.updateMessageContent('msg-missing', 'x');

      expect(ok).toBe(false);
      expect(mockRedisService.del).not.toHaveBeenCalled();
    });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== getChatMessages ====================

  describe('getChatMessages', () => {
    it('should call repository with today when no date provided', async () => {
      const mockMessages = [{ id: '1', content: 'hello' }];
      mockChatMessageRepository.getTodayChatMessages.mockResolvedValue(mockMessages);

      const result = await service.getChatMessages();

      expect(result).toEqual(mockMessages);
      const [date, page, pageSize] = mockChatMessageRepository.getTodayChatMessages.mock.calls[0];
      expect(date).toBeInstanceOf(Date);
      expect(page).toBe(1);
      expect(pageSize).toBe(50);
    });

    it('should use provided date, page, and pageSize', async () => {
      mockChatMessageRepository.getTodayChatMessages.mockResolvedValue([]);

      await service.getChatMessages('2024-06-15', 2, 100);

      const [date, page, pageSize] = mockChatMessageRepository.getTodayChatMessages.mock.calls[0];
      expect(date.toISOString().startsWith('2024-06-15')).toBe(true);
      expect(page).toBe(2);
      expect(pageSize).toBe(100);
    });
  });

  // ==================== getChatSessions ====================

  describe('getChatSessions', () => {
    const emptyPage = { sessions: [], total: 0, nextCursor: null };

    it('should use date range when startDate is provided', async () => {
      const mockPage = { sessions: [{ chatId: 'chat1' }], total: 1, nextCursor: null };
      mockChatMessageRepository.getChatSessionPage.mockResolvedValue(mockPage);

      const result = await service.getChatSessions({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      });

      expect(result).toEqual(mockPage);
      expect(mockChatMessageRepository.getChatSessionPage).toHaveBeenCalledTimes(1);
      expect(mockChatMessageRepository.getChatSessionList).not.toHaveBeenCalled();

      const [{ startDate, endDate }] = mockChatMessageRepository.getChatSessionPage.mock.calls[0];
      expect(startDate.getHours()).toBe(0); // start of day
      expect(endDate.getHours()).toBe(23); // end of day
    });

    it('should use days-based query when no startDate provided', async () => {
      const mockPage = { sessions: [{ chatId: 'chat1' }], total: 1, nextCursor: null };
      mockChatMessageRepository.getChatSessionList.mockResolvedValue(mockPage);

      const result = await service.getChatSessions({ days: '7' });

      expect(result).toEqual(mockPage);
      expect(mockChatMessageRepository.getChatSessionList).toHaveBeenCalledWith(7, 600);
      expect(mockChatMessageRepository.getChatSessionPage).not.toHaveBeenCalled();
    });

    it('should default to 1 day when no days option provided', async () => {
      mockChatMessageRepository.getChatSessionList.mockResolvedValue(emptyPage);

      await service.getChatSessions({});

      expect(mockChatMessageRepository.getChatSessionList).toHaveBeenCalledWith(1, 600);
    });

    it('should use end of today when no endDate provided for date range', async () => {
      mockChatMessageRepository.getChatSessionPage.mockResolvedValue(emptyPage);

      await service.getChatSessions({ startDate: '2024-01-01' });

      const [{ endDate }] = mockChatMessageRepository.getChatSessionPage.mock.calls[0];
      expect(endDate.getHours()).toBe(23);
      expect(endDate.getMinutes()).toBe(59);
    });
  });

  // ==================== getChatDailyStats ====================

  describe('getChatDailyStats', () => {
    it('should call repository with 30-day default range', async () => {
      const mockStats = [{ date: '2024-01-01', count: 10 }];
      mockChatMessageRepository.getChatDailyStats.mockResolvedValue(mockStats);

      const result = await service.getChatDailyStats();

      expect(result).toEqual(mockStats);
      const [start, end] = mockChatMessageRepository.getChatDailyStats.mock.calls[0];
      expect(start).toBeInstanceOf(Date);
      expect(end).toBeInstanceOf(Date);
      expect(start.getHours()).toBe(0);
      expect(end.getHours()).toBe(23);
    });

    it('should use provided date range', async () => {
      mockChatMessageRepository.getChatDailyStats.mockResolvedValue([]);

      await service.getChatDailyStats('2024-01-01', '2024-01-31');

      const [start, end] = mockChatMessageRepository.getChatDailyStats.mock.calls[0];
      // Check full year/month match (local time)
      expect(start.getFullYear()).toBe(2024);
      expect(start.getMonth()).toBe(0); // January = 0
      expect(start.getDate()).toBe(1);
      expect(start.getHours()).toBe(0);
      expect(end.getHours()).toBe(23);
    });
  });

  // ==================== getChatSummaryStats ====================

  describe('getChatSummaryStats', () => {
    it('should call repository with 30-day default range', async () => {
      const mockStats = { total: 100, active: 50 };
      mockChatMessageRepository.getChatSummaryStats.mockResolvedValue(mockStats);

      const result = await service.getChatSummaryStats();

      expect(result).toEqual(mockStats);
      expect(mockChatMessageRepository.getChatSummaryStats).toHaveBeenCalledTimes(1);
      const [start] = mockChatMessageRepository.getChatSummaryStats.mock.calls[0];
      expect(start.getHours()).toBe(0); // start of day
    });

    it('should use provided date range', async () => {
      mockChatMessageRepository.getChatSummaryStats.mockResolvedValue(null);

      await service.getChatSummaryStats('2024-06-01', '2024-06-30');

      const [start, end] = mockChatMessageRepository.getChatSummaryStats.mock.calls[0];
      expect(start.getFullYear()).toBe(2024);
      expect(start.getMonth()).toBe(5); // June = 5
      expect(start.getDate()).toBe(1);
      expect(end.getHours()).toBe(23);
    });
  });

  // ==================== getChatSessionsOptimized ====================

  describe('getChatSessionsOptimized', () => {
    const emptyPage = { sessions: [], total: 0, nextCursor: null };

    it('should call getChatSessionPage with 30-day range', async () => {
      const mockPage = { sessions: [{ chatId: 'chat1', messageCount: 10 }], total: 1, nextCursor: null };
      mockChatMessageRepository.getChatSessionPage.mockResolvedValue(mockPage);

      const result = await service.getChatSessionsOptimized({});

      expect(result).toEqual(mockPage);
      expect(mockChatMessageRepository.getChatSessionPage).toHaveBeenCalledTimes(1);
    });

    it('should use provided date range', async () => {
      mockChatMessageRepository.getChatSessionPage.mockResolvedValue(emptyPage);

      await service.getChatSessionsOptimized({ startDate: '2024-01-01', endDate: '2024-01-31' });

      const [{ startDate, endDate }] = mockChatMessageRepository.getChatSessionPage.mock.calls[0];
      expect(startDate.getFullYear()).toBe(2024);
      expect(startDate.getMonth()).toBe(0); // January = 0
      expect(startDate.getDate()).toBe(1);
      expect(endDate.getHours()).toBe(23);
    });

    it('should default the page size when limit is absent or invalid', async () => {
      mockChatMessageRepository.getChatSessionPage.mockResolvedValue(emptyPage);

      await service.getChatSessionsOptimized({ limit: 'abc' });

      const [query] = mockChatMessageRepository.getChatSessionPage.mock.calls[0];
      expect(query.limit).toBe(600);
    });

    it('should pass search and cursor through', async () => {
      mockChatMessageRepository.getChatSessionPage.mockResolvedValue(emptyPage);

      await service.getChatSessionsOptimized({
        limit: '50',
        search: 'Alice',
        cursorTimestamp: '2026-09-01T09:00:00.000Z',
        cursorChatId: 'chat_002',
      });

      const [query] = mockChatMessageRepository.getChatSessionPage.mock.calls[0];
      expect(query.limit).toBe(50);
      expect(query.search).toBe('Alice');
      expect(query.cursor).toEqual({
        timestamp: '2026-09-01T09:00:00.000Z',
        chatId: 'chat_002',
      });
    });

    it('should ignore a half-specified cursor', async () => {
      mockChatMessageRepository.getChatSessionPage.mockResolvedValue(emptyPage);

      // 游标必须成对出现，只有时间戳时无法定位排序键，应视为从头开始
      await service.getChatSessionsOptimized({ cursorTimestamp: '2026-09-01T09:00:00.000Z' });

      const [query] = mockChatMessageRepository.getChatSessionPage.mock.calls[0];
      expect(query.cursor).toBeUndefined();
    });
  });

  // ==================== getChatSessionMessages ====================

  describe('getChatSessionMessages', () => {
    it('should return session messages with chatId', async () => {
      const mockMessages = [
        { id: '1', content: 'hello' },
        { id: '2', content: 'world' },
      ];
      mockChatMessageRepository.getChatHistoryDetail.mockResolvedValue(mockMessages);

      const result = await service.getChatSessionMessages('chat-123');

      expect(result).toEqual({ chatId: 'chat-123', messages: mockMessages });
      expect(mockChatMessageRepository.getChatHistoryDetail).toHaveBeenCalledWith('chat-123');
    });

    it('should return empty messages array when no messages found', async () => {
      mockChatMessageRepository.getChatHistoryDetail.mockResolvedValue([]);

      const result = await service.getChatSessionMessages('chat-empty');

      expect(result).toEqual({ chatId: 'chat-empty', messages: [] });
    });

    it('should pass through repository errors', async () => {
      mockChatMessageRepository.getChatHistoryDetail.mockRejectedValue(new Error('DB error'));

      await expect(service.getChatSessionMessages('chat-123')).rejects.toThrow('DB error');
    });
  });
});

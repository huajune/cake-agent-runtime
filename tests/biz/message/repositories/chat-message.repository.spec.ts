import { Test, TestingModule } from '@nestjs/testing';
import { ChatMessageRepository } from '@biz/message/repositories/chat-message.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { StorageMessageSource, StorageMessageType } from '@enums/storage-message.enum';

function makeQueryMock(result: { data?: unknown; error?: unknown; count?: number }) {
  const chainMethods = [
    'select',
    'insert',
    'update',
    'upsert',
    'delete',
    'eq',
    'neq',
    'gte',
    'lte',
    'gt',
    'lt',
    'in',
    'or',
    'order',
    'limit',
    'range',
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mock: any = Object.assign(Promise.resolve(result), {});
  for (const m of chainMethods) {
    mock[m] = jest.fn().mockReturnValue(mock);
  }
  return mock;
}

describe('ChatMessageRepository', () => {
  let repository: ChatMessageRepository;

  const mockSupabaseClient = {
    from: jest.fn(),
    rpc: jest.fn(),
  };

  const mockSupabaseService = {
    getSupabaseClient: jest.fn().mockReturnValue(mockSupabaseClient),
    isClientInitialized: jest.fn().mockReturnValue(true),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSupabaseService.getSupabaseClient.mockReturnValue(mockSupabaseClient);
    mockSupabaseService.isClientInitialized.mockReturnValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatMessageRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<ChatMessageRepository>(ChatMessageRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== saveChatMessage ====================

  describe('saveChatMessage', () => {
    const userMessage = {
      chatId: 'chat_001',
      messageId: 'msg_001',
      role: 'user' as const,
      content: 'Hello',
      timestamp: Date.now(),
      contactType: 1,
      isRoom: false,
    };

    it('should report not-inserted when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.saveChatMessage(userMessage);

      expect(result).toEqual({ inserted: false });
    });

    it('should skip room messages without touching supabase', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const result = await repository.saveChatMessage({ ...userMessage, isRoom: true });

      expect(result).toEqual({ inserted: false });
      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should skip non-personal user messages (contactType !== 1)', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const result = await repository.saveChatMessage({
        ...userMessage,
        role: 'user',
        contactType: 2,
        isRoom: false,
      });

      expect(result).toEqual({ inserted: false });
      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should report inserted=true when DB returns the new row', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      // upsert + .select() returns the newly inserted row
      const upsertResult = makeQueryMock({
        data: [{ message_id: userMessage.messageId }],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(upsertResult);

      const result = await repository.saveChatMessage(userMessage);

      expect(result).toEqual({ inserted: true });
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('chat_messages');
    });

    it('should report inserted=false when message_id conflicts (ignoreDuplicates)', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      // ignoreDuplicates=true makes PostgREST return empty rows on conflict
      const upsertResult = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(upsertResult);

      const result = await repository.saveChatMessage(userMessage);

      expect(result).toEqual({ inserted: false });
    });

    it('should save assistant messages regardless of contactType', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const upsertResult = makeQueryMock({
        data: [{ message_id: userMessage.messageId }],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(upsertResult);

      const result = await repository.saveChatMessage({
        ...userMessage,
        role: 'assistant',
        contactType: undefined,
      });

      expect(result).toEqual({ inserted: true });
    });

    it('should report inserted=false when underlying upsert encounters a db error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      // BaseRepository.upsert() swallows errors and returns null → inserted=false
      const errorResult = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(errorResult);

      const result = await repository.saveChatMessage(userMessage);

      expect(result).toEqual({ inserted: false });
    });
  });

  // ==================== saveChatMessagesBatch ====================

  describe('saveChatMessagesBatch', () => {
    it('should return empty set when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.saveChatMessagesBatch([]);

      expect(result.insertedIds.size).toBe(0);
    });

    it('should return empty set for empty array', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const result = await repository.saveChatMessagesBatch([]);

      expect(result.insertedIds.size).toBe(0);
    });

    it('should skip all room messages and return empty set', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const result = await repository.saveChatMessagesBatch([
        {
          chatId: 'chat_001',
          messageId: 'msg_001',
          role: 'user',
          content: 'hi',
          timestamp: Date.now(),
          isRoom: true,
        },
        {
          chatId: 'chat_001',
          messageId: 'msg_002',
          role: 'user',
          content: 'hello',
          timestamp: Date.now(),
          isRoom: true,
        },
      ]);

      expect(result.insertedIds.size).toBe(0);
      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should return only actually-inserted message ids', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      // PostgREST 在 ignoreDuplicates=true 时只返回真正新插入的行；msg_002 视为冲突被忽略。
      const upsertResult = makeQueryMock({
        data: [{ message_id: 'msg_001' }],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(upsertResult);

      const messages = [
        {
          chatId: 'chat_001',
          messageId: 'msg_001',
          role: 'user' as const,
          content: 'hi',
          timestamp: Date.now(),
          isRoom: false,
          contactType: 1,
        },
        {
          chatId: 'chat_001',
          messageId: 'msg_002',
          role: 'assistant' as const,
          content: 'hey',
          timestamp: Date.now(),
          isRoom: false,
        },
      ];

      const result = await repository.saveChatMessagesBatch(messages);

      expect(Array.from(result.insertedIds)).toEqual(['msg_001']);
    });

    it('should return empty set on batch save error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.from.mockImplementation(() => {
        throw new Error('DB error');
      });

      const messages = [
        {
          chatId: 'chat_001',
          messageId: 'msg_001',
          role: 'user' as const,
          content: 'hi',
          timestamp: Date.now(),
          isRoom: false,
          contactType: 1,
        },
      ];

      const result = await repository.saveChatMessagesBatch(messages);

      expect(result.insertedIds.size).toBe(0);
    });
  });

  // ==================== getChatHistory ====================

  describe('getChatHistory', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getChatHistory('chat_001');

      expect(result).toEqual([]);
    });

    it('should return chat history in chronological order', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const dbRows = [
        {
          message_id: 'msg-2',
          role: 'assistant',
          content: 'Hello!',
          timestamp: '2026-03-10T10:01:00Z',
          source: StorageMessageSource.AGGREGATED_CHAT_MANUAL,
          message_type: StorageMessageType.TEXT,
          is_self: true,
          payload_source: 'callback',
        },
        {
          message_id: 'msg-1',
          role: 'user',
          content: 'Hi',
          timestamp: '2026-03-10T10:00:00Z',
          source: StorageMessageSource.MOBILE_PUSH,
          message_type: StorageMessageType.TEXT,
          is_self: false,
        },
      ];

      const queryMock = makeQueryMock({ data: dbRows, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getChatHistory('chat_001');

      // Results should be reversed (oldest first)
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[1].role).toBe('assistant');
      expect(result[0].content).toBe('Hi');
      expect(result[1]).toMatchObject({
        messageId: 'msg-2',
        source: StorageMessageSource.AGGREGATED_CHAT_MANUAL,
        messageType: StorageMessageType.TEXT,
        isSelf: true,
        payloadSource: 'callback',
      });
      expect(queryMock.select).toHaveBeenCalledWith(
        'message_id,role,content,timestamp,source,message_type,is_self,payload_source:payload->>source',
      );
    });

    it('should use custom limit', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getChatHistory('chat_001', 10);

      expect(result).toEqual([]);
    });

    it('should apply explicit start time when provided', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);
      const startTime = Date.UTC(2026, 2, 10, 8, 0, 0);

      await repository.getChatHistory('chat_001', 10, { startTimeInclusive: startTime });

      expect(queryMock.gte).toHaveBeenCalledWith('timestamp', new Date(startTime).toISOString());
    });

    it('should return empty array on error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getChatHistory('chat_001');

      expect(result).toEqual([]);
    });
  });

  // ==================== getChatHistoryDetail ====================

  describe('getChatHistoryDetail', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getChatHistoryDetail('chat_001');

      expect(result).toEqual([]);
    });

    it('should return detailed chat history with all fields', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const dbRows = [
        {
          message_id: 'msg_001',
          role: 'user',
          content: 'Hello',
          timestamp: '2026-03-10T10:00:00Z',
          candidate_name: 'Alice',
          manager_name: 'Bob',
          message_type: '1',
          source: 'wecom',
          contact_type: '1',
          is_self: false,
          avatar: 'https://example.com/avatar.png',
          external_user_id: 'ext_001',
        },
      ];

      const queryMock = makeQueryMock({ data: dbRows, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getChatHistoryDetail('chat_001');

      expect(result).toHaveLength(1);
      expect(result[0].messageId).toBe('msg_001');
      expect(result[0].role).toBe('user');
      expect(result[0].content).toBe('Hello');
      expect(result[0].candidateName).toBe('Alice');
      expect(result[0].managerName).toBe('Bob');
      expect(result[0].externalUserId).toBe('ext_001');
    });
  });

  // ==================== getTodayChatMessages ====================

  describe('getTodayChatMessages', () => {
    it('should return empty result when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getTodayChatMessages();

      expect(result.messages).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should return paginated messages', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const dbRows = [
        {
          id: 'id_001',
          chat_id: 'chat_001',
          role: 'user',
          content: 'Hello',
          timestamp: new Date().toISOString(),
          candidate_name: 'Alice',
          manager_name: 'Bob',
        },
      ];

      const queryMock = makeQueryMock({ data: dbRows, error: null, count: 1 });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getTodayChatMessages(new Date(), 1, 50);

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(50);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].chatId).toBe('chat_001');
    });
  });

  // ==================== getAllChatIds ====================

  describe('getAllChatIds', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getAllChatIds();

      expect(result).toEqual([]);
    });

    it('should return chat IDs from RPC result', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [{ chat_id: 'chat_001' }, { chat_id: 'chat_002' }],
        error: null,
      });

      const result = await repository.getAllChatIds();

      expect(result).toEqual(['chat_001', 'chat_002']);
    });

    it('should fallback to direct query when RPC returns null', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      const fallbackRows = [
        { chat_id: 'chat_001' },
        { chat_id: 'chat_001' }, // duplicate
        { chat_id: 'chat_002' },
      ];
      const queryMock = makeQueryMock({ data: fallbackRows, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getAllChatIds();

      // Should deduplicate
      expect(result).toEqual(['chat_001', 'chat_002']);
    });
  });

  // ==================== getChatSessionList ====================

  describe('getChatSessionList', () => {
    it('should return an empty page when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getChatSessionList();

      expect(result).toEqual({ sessions: [], total: 0, nextCursor: null });
    });

    it('should return session summaries from RPC', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [
          {
            chat_id: 'chat_001',
            candidate_name: 'Alice',
            manager_name: 'Bob',
            message_count: '2',
            last_message: 'I am fine',
            last_timestamp: '2026-09-01T10:00:00.000Z',
            avatar: null,
            contact_type: '1',
            total_count: '2',
          },
          {
            chat_id: 'chat_002',
            candidate_name: 'Carol',
            manager_name: 'Dave',
            message_count: '1',
            last_message: 'Another session',
            last_timestamp: '2026-09-01T09:00:00.000Z',
            avatar: null,
            contact_type: '1',
            total_count: '2',
          },
        ],
        error: null,
      });

      const result = await repository.getChatSessionList(1);

      expect(result.sessions).toHaveLength(2);
      expect(result.total).toBe(2);
      const chat001 = result.sessions.find((s) => s.chatId === 'chat_001');
      expect(chat001).toBeDefined();
      expect(chat001?.messageCount).toBe(2);
    });
  });

  // ==================== getChatSessionPage ====================

  describe('getChatSessionPage', () => {
    const query = { startDate: new Date(), endDate: new Date(), limit: 2 };

    it('should return an empty page when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getChatSessionPage(query);

      expect(result).toEqual({ sessions: [], total: 0, nextCursor: null });
    });

    it('should return mapped sessions and the true total', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [
          {
            chat_id: 'chat_001',
            candidate_name: 'Alice',
            manager_name: 'Bob',
            message_count: '5',
            last_message: 'Goodbye',
            last_timestamp: '2026-09-01T10:00:00.000Z',
            avatar: null,
            contact_type: '1',
            total_count: '37',
          },
        ],
        error: null,
      });

      const result = await repository.getChatSessionPage(query);

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].chatId).toBe('chat_001');
      expect(result.sessions[0].messageCount).toBe(5);
      // total 是时间窗内的总数，与本页条数无关
      expect(result.total).toBe(37);
      // 返回条数未超过 limit → 已到末页
      expect(result.nextCursor).toBeNull();
    });

    it('should over-fetch by one to detect the next page and trim it off', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [
          {
            chat_id: 'chat_001',
            candidate_name: 'Alice',
            manager_name: 'Bob',
            message_count: '5',
            last_message: 'a',
            last_timestamp: '2026-09-01T10:00:00.000Z',
            avatar: null,
            contact_type: '1',
            total_count: '9',
          },
          {
            chat_id: 'chat_002',
            candidate_name: 'Carol',
            manager_name: 'Dave',
            message_count: '3',
            last_message: 'b',
            last_timestamp: '2026-09-01T09:00:00.000Z',
            avatar: null,
            contact_type: '1',
            total_count: '9',
          },
          {
            chat_id: 'chat_003',
            candidate_name: 'Eve',
            manager_name: 'Frank',
            message_count: '1',
            last_message: 'c',
            last_timestamp: '2026-09-01T08:00:00.000Z',
            avatar: null,
            contact_type: '1',
            total_count: '9',
          },
        ],
        error: null,
      });

      const result = await repository.getChatSessionPage(query);

      // limit=2 → 请求 3 条，多出的第 3 条只用于判断还有下一页
      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
        'get_chat_session_list',
        expect.objectContaining({ p_limit: 3 }),
      );
      expect(result.sessions).toHaveLength(2);
      // 游标锚在本页最后一条上，而非被裁掉的探测条
      expect(result.nextCursor).toEqual({
        timestamp: '2026-09-01T09:00:00.000Z',
        chatId: 'chat_002',
      });
    });

    it('should push the search term and cursor down to the RPC', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      mockSupabaseClient.rpc.mockResolvedValue({ data: [], error: null });

      await repository.getChatSessionPage({
        ...query,
        search: '  Alice  ',
        cursor: { timestamp: '2026-09-01T09:00:00.000Z', chatId: 'chat_002' },
      });

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
        'get_chat_session_list',
        expect.objectContaining({
          p_search: 'Alice',
          p_cursor_timestamp: '2026-09-01T09:00:00.000Z',
          p_cursor_chat_id: 'chat_002',
        }),
      );
    });

    it('should send a null search term when the term is blank', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      mockSupabaseClient.rpc.mockResolvedValue({ data: [], error: null });

      await repository.getChatSessionPage({ ...query, search: '   ' });

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
        'get_chat_session_list',
        expect.objectContaining({ p_search: null }),
      );
    });

    it('should clamp the page size to the maximum', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      mockSupabaseClient.rpc.mockResolvedValue({ data: [], error: null });

      await repository.getChatSessionPage({ ...query, limit: 100000 });

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
        'get_chat_session_list',
        expect.objectContaining({ p_limit: 501 }),
      );
    });

    it('should return an empty page when RPC returns null', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      const result = await repository.getChatSessionPage(query);

      expect(result).toEqual({ sessions: [], total: 0, nextCursor: null });
    });
  });

  // ==================== getChatDailyStats ====================

  describe('getChatDailyStats', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getChatDailyStats(new Date(), new Date());

      expect(result).toEqual([]);
    });

    it('should return mapped daily stats', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [{ date: '2026-03-10', message_count: '42', session_count: '10' }],
        error: null,
      });

      const result = await repository.getChatDailyStats(new Date(), new Date());

      expect(result).toHaveLength(1);
      expect(result[0].date).toBe('2026-03-10');
      expect(result[0].messageCount).toBe(42);
      expect(result[0].sessionCount).toBe(10);
    });
  });

  // ==================== getChatSummaryStats ====================

  describe('getChatSummaryStats', () => {
    it('should return zeros when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getChatSummaryStats(new Date(), new Date());

      expect(result).toEqual({ totalSessions: 0, totalMessages: 0, activeSessions: 0 });
    });

    it('should return parsed summary stats', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [{ total_sessions: '25', total_messages: '200', active_sessions: '15' }],
        error: null,
      });

      const result = await repository.getChatSummaryStats(new Date(), new Date());

      expect(result.totalSessions).toBe(25);
      expect(result.totalMessages).toBe(200);
      expect(result.activeSessions).toBe(15);
    });

    it('should return zeros when RPC returns empty array', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: [], error: null });

      const result = await repository.getChatSummaryStats(new Date(), new Date());

      expect(result).toEqual({ totalSessions: 0, totalMessages: 0, activeSessions: 0 });
    });
  });

  // ==================== cleanupChatMessages ====================

  describe('cleanupChatMessages', () => {
    it('should return 0 when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.cleanupChatMessages(90);

      expect(result).toBe(0);
    });

    it('should return deleted count from RPC', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: 42, error: null });

      const result = await repository.cleanupChatMessages(90);

      expect(result).toBe(42);
    });

    it('should return 0 when RPC returns null', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      const result = await repository.cleanupChatMessages(90);

      expect(result).toBe(0);
    });
  });

  // ==================== getChatMessagesByTimeRange ====================

  describe('getChatMessagesByTimeRange', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getChatMessagesByTimeRange(0, Date.now());

      expect(result).toEqual([]);
    });

    it('should return grouped messages by chatId', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const now = Date.now();
      const dbRows = [
        {
          chat_id: 'chat_001',
          message_id: 'msg_001',
          role: 'user',
          content: 'Hi',
          timestamp: new Date(now - 2000).toISOString(),
          candidate_name: 'Alice',
          manager_name: 'Bob',
        },
        {
          chat_id: 'chat_001',
          message_id: 'msg_002',
          role: 'assistant',
          content: 'Hello!',
          timestamp: new Date(now - 1000).toISOString(),
          candidate_name: null,
          manager_name: 'Bob',
        },
        {
          chat_id: 'chat_002',
          message_id: 'msg_003',
          role: 'user',
          content: 'Hey',
          timestamp: new Date(now).toISOString(),
          candidate_name: 'Carol',
          manager_name: null,
        },
      ];

      const queryMock = makeQueryMock({ data: dbRows, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getChatMessagesByTimeRange(now - 10000, now + 1000);

      expect(result).toHaveLength(2);
      const chat001 = result.find((g) => g.chatId === 'chat_001');
      expect(chat001?.messages).toHaveLength(2);
      const chat002 = result.find((g) => g.chatId === 'chat_002');
      expect(chat002?.messages).toHaveLength(1);
    });
  });

  describe('getChatBusinessDailyTrend / getBusinessDataFloor', () => {
    it('maps the business-trend RPC rows and coerces bigint strings to numbers', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({
        data: [
          { date: '2026-08-31', message_count: '3788', session_count: 367 },
          { date: '2026-09-01', message_count: null, session_count: 'abc' },
        ],
        error: null,
      });

      const result = await repository.getChatBusinessDailyTrend('2026-08-31', '2026-09-01');

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('get_chat_business_daily_trend', {
        p_start_date: '2026-08-31',
        p_end_date: '2026-09-01',
      });
      expect(result).toEqual([
        { date: '2026-08-31', messageCount: 3788, sessionCount: 367 },
        { date: '2026-09-01', messageCount: 0, sessionCount: 0 },
      ]);
    });

    it('maps the data-floor RPC row and nulls when empty', async () => {
      mockSupabaseClient.rpc.mockResolvedValueOnce({
        data: [
          {
            ops_events_from: '2026-02-12',
            daily_ops_report_from: '2026-02-12',
            user_activity_from: null,
          },
        ],
        error: null,
      });
      await expect(repository.getBusinessDataFloor()).resolves.toEqual({
        opsEventsFrom: '2026-02-12',
        dailyOpsReportFrom: '2026-02-12',
        userActivityFrom: null,
      });

      mockSupabaseClient.rpc.mockResolvedValueOnce({ data: [], error: null });
      await expect(repository.getBusinessDataFloor()).resolves.toEqual({
        opsEventsFrom: null,
        dailyOpsReportFrom: null,
        userActivityFrom: null,
      });
    });

    it('returns empty results without calling the RPC when supabase is unavailable', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      await expect(
        repository.getChatBusinessDailyTrend('2026-08-01', '2026-08-02'),
      ).resolves.toEqual([]);
      await expect(repository.getBusinessDataFloor()).resolves.toEqual({
        opsEventsFrom: null,
        dailyOpsReportFrom: null,
        userActivityFrom: null,
      });
      expect(mockSupabaseClient.rpc).not.toHaveBeenCalled();
    });
  });
});

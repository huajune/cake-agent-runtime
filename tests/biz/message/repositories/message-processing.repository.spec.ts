import { Test, TestingModule } from '@nestjs/testing';
import { MessageProcessingRepository } from '@biz/message/repositories/message-processing.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';

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
    'ilike',
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

const baseRecord = {
  messageId: 'msg_001',
  chatId: 'chat_001',
  userId: 'user_001',
  userName: 'Alice',
  managerName: 'Bob',
  receivedAt: Date.now(),
  messagePreview: 'Hello',
  replyPreview: 'Hi there',
  status: 'success' as const,
  aiDuration: 1200,
  totalDuration: 1500,
};

describe('MessageProcessingRepository', () => {
  let repository: MessageProcessingRepository;

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
        MessageProcessingRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<MessageProcessingRepository>(MessageProcessingRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== saveMessageProcessingRecord ====================

  describe('saveMessageProcessingRecord', () => {
    it('should return false when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.saveMessageProcessingRecord(baseRecord);

      expect(result).toBe(false);
    });

    it('should return true on successful save', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const upsertResult = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(upsertResult);

      const result = await repository.saveMessageProcessingRecord(baseRecord);

      expect(result).toBe(true);
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('message_processing_records');
    });

    it('should return true even when underlying upsert encounters a db error (error is swallowed by BaseRepository.upsert)', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      // BaseRepository.upsert() catches all errors internally via handleError() and returns null,
      // so saveMessageProcessingRecord() does not see any thrown error and returns true.
      const errorResult = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(errorResult);

      const result = await repository.saveMessageProcessingRecord(baseRecord);

      expect(result).toBe(true);
    });
  });

  describe('saveMessageProcessingRecord → message_processing_invocations 子表', () => {
    beforeEach(() => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
    });

    it('writes the invocation snapshot to the child table instead of the main row', async () => {
      const mainUpsert = makeQueryMock({ data: null, error: null });
      const childUpsert = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockImplementation((table: string) =>
        table === 'message_processing_invocations' ? childUpsert : mainUpsert,
      );
      const invocation = { request: { agentRequest: 'prompt' }, response: { text: 'hi' } };

      const result = await repository.saveMessageProcessingRecord({
        ...baseRecord,
        agentInvocation: invocation,
      });

      expect(result).toBe(true);
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('message_processing_invocations');
      expect(childUpsert.upsert).toHaveBeenCalledWith(
        { message_id: baseRecord.messageId, agent_invocation: invocation },
        { onConflict: 'message_id' },
      );
      // 主表不再落 agent_invocation（59 KB/行的快照与高频更新的标量分开住）
      const mainPayload = mainUpsert.upsert.mock.calls[0][0] as Record<string, unknown>;
      expect(mainPayload).not.toHaveProperty('agent_invocation');
      expect(mainPayload).not.toHaveProperty('ai_start_at');
    });

    it('skips the child table when the record carries no invocation', async () => {
      const mainUpsert = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(mainUpsert);

      await repository.saveMessageProcessingRecord(baseRecord);

      expect(mockSupabaseClient.from).not.toHaveBeenCalledWith('message_processing_invocations');
    });
  });

  // ==================== getSlowestMessages ====================

  describe('getSlowestMessages', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getSlowestMessages();

      expect(result).toEqual([]);
    });

    it('should return mapped slow messages', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const now = Date.now();
      const dbRows = [
        {
          message_id: 'msg_001',
          chat_id: 'chat_001',
          user_id: 'user_001',
          user_name: 'Alice',
          manager_name: 'Bob',
          received_at: new Date(now).toISOString(),
          message_preview: 'Hello',
          reply_preview: 'Hi',
          reply_segments: null,
          status: 'success',
          error: null,
          scenario: null,
          total_duration: 2000,
          queue_duration: null,
          prep_duration: null,
          ai_start_at: null,
          ai_end_at: null,
          ai_duration: 1800,
          send_duration: null,
          token_usage: 100,
          is_fallback: false,
          fallback_success: null,
          agent_invocation: null,
          batch_id: null,
        },
      ];

      const queryMock = makeQueryMock({ data: dbRows, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getSlowestMessages();

      expect(result).toHaveLength(1);
      expect(result[0].messageId).toBe('msg_001');
      expect(result[0].aiDuration).toBe(1800);
    });

    it('should apply time range filters when provided', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const now = Date.now();
      const result = await repository.getSlowestMessages(now - 3600000, now, 5);

      expect(result).toEqual([]);
    });

    it('should apply manager filters when provided', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      await repository.getSlowestMessages(undefined, undefined, 10, {
        managerNames: ['LiHanTing'],
      });

      expect(queryMock.ilike).toHaveBeenCalledWith('manager_name', '%LiHanTing%');
    });
  });

  // ==================== getMessageProcessingRecords ====================

  describe('getMessageProcessingRecords', () => {
    it('should return empty result when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getMessageProcessingRecords({});

      expect(result).toEqual({ records: [], total: 0 });
    });

    it('should return records with total count', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const now = Date.now();
      const dbRow = {
        message_id: 'msg_001',
        chat_id: 'chat_001',
        user_id: 'user_001',
        user_name: 'Alice',
        manager_name: 'Bob',
        received_at: new Date(now).toISOString(),
        message_preview: 'Hello',
        reply_preview: 'Hi',
        reply_segments: null,
        status: 'success',
        error: null,
        scenario: null,
        total_duration: 1500,
        queue_duration: null,
        prep_duration: null,
        ai_start_at: null,
        ai_end_at: null,
        ai_duration: 1200,
        send_duration: null,
        token_usage: 80,
        is_fallback: false,
        fallback_success: null,
        agent_invocation: null,
        batch_id: null,
      };

      const queryMock = makeQueryMock({ data: [dbRow], error: null, count: 1 });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getMessageProcessingRecords({ limit: 10 });

      expect(result.records).toHaveLength(1);
      expect(result.records[0].messageId).toBe('msg_001');
    });

    it('should skip exact count and heavy diagnostic fields for summary projections', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const now = Date.now();
      const dbRow = {
        message_id: 'msg_001',
        chat_id: 'chat_001',
        user_id: 'user_001',
        user_name: 'Alice',
        manager_name: 'Bob',
        received_at: new Date(now).toISOString(),
        message_preview: 'Hello',
        reply_preview: 'Hi',
        reply_segments: null,
        status: 'success',
        total_duration: 1500,
        queue_duration: null,
        prep_duration: null,
        ai_duration: 1200,
        ttft_ms: 250,
        send_duration: null,
        token_usage: 80,
        is_fallback: false,
        fallback_success: null,
      };

      const queryMock = makeQueryMock({ data: [dbRow], error: null, count: 1 });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getMessageProcessingRecords({
        limit: 10,
        includeTotal: false,
        projection: 'summary',
      });

      expect(result.records).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockSupabaseClient.from).toHaveBeenCalledTimes(1);
      expect(queryMock.select).toHaveBeenCalledTimes(1);
      const [selectedColumns] = queryMock.select.mock.calls[0];
      expect(selectedColumns).toContain('message_id');
      expect(selectedColumns).not.toContain('tool_calls');
      expect(selectedColumns).not.toContain('agent_steps');
      expect(selectedColumns).not.toContain('memory_snapshot');
    });

    it('should filter by status when provided', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null, count: 0 });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getMessageProcessingRecords({ status: 'failure' });

      expect(result.records).toEqual([]);
    });

    it('should filter by manager aliases when provided', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null, count: 0 });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      await repository.getMessageProcessingRecords({
        managerNames: ['LiHanTing', '李涵婷'],
      });

      expect(queryMock.or).toHaveBeenCalledWith(
        'manager_name.ilike.%LiHanTing%,manager_name.ilike.%李涵婷%',
      );
    });
  });

  // ==================== getMessageProcessingRecordById ====================

  describe('getMessageProcessingRecordById', () => {
    it('should return null when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getMessageProcessingRecordById('msg_001');

      expect(result).toBeNull();
    });

    it('should return null when record not found', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getMessageProcessingRecordById('nonexistent');

      expect(result).toBeNull();
    });

    it('should return mapped record when found', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const now = Date.now();
      const dbRow = {
        message_id: 'msg_001',
        chat_id: 'chat_001',
        user_id: 'user_001',
        user_name: 'Alice',
        manager_name: 'Bob',
        received_at: new Date(now).toISOString(),
        message_preview: 'Hello',
        reply_preview: 'Hi',
        reply_segments: null,
        status: 'success',
        error: null,
        scenario: 'interview',
        total_duration: 1500,
        queue_duration: 100,
        prep_duration: 200,
        ai_start_at: null,
        ai_end_at: null,
        ai_duration: 1200,
        send_duration: null,
        token_usage: 100,
        is_fallback: false,
        fallback_success: null,
        agent_invocation: null,
        batch_id: 'batch_001',
      };

      const queryMock = makeQueryMock({ data: [dbRow], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getMessageProcessingRecordById('msg_001');

      expect(result).not.toBeNull();
      expect(result?.messageId).toBe('msg_001');
      expect(result?.chatId).toBe('chat_001');
      expect(result?.scenario).toBe('interview');
      expect(result?.batchId).toBe('batch_001');
    });

    it('prefers the embedded child-table invocation over the legacy column', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      const dbRow = {
        message_id: 'msg_002',
        chat_id: 'chat_001',
        user_id: 'user_001',
        received_at: new Date().toISOString(),
        status: 'success',
        agent_invocation: { legacy: true },
        message_processing_invocations: [{ agent_invocation: { fromChild: true } }],
      };
      mockSupabaseClient.from.mockReturnValue(makeQueryMock({ data: [dbRow], error: null }));

      const result = await repository.getMessageProcessingRecordById('msg_002');

      expect(result?.agentInvocation).toEqual({ fromChild: true });
    });

    it('falls back to the legacy agent_invocation column for rows written before the split', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      const dbRow = {
        message_id: 'msg_003',
        chat_id: 'chat_001',
        user_id: 'user_001',
        received_at: new Date().toISOString(),
        status: 'success',
        agent_invocation: { legacy: true },
        message_processing_invocations: [],
      };
      mockSupabaseClient.from.mockReturnValue(makeQueryMock({ data: [dbRow], error: null }));

      const result = await repository.getMessageProcessingRecordById('msg_003');

      expect(result?.agentInvocation).toEqual({ legacy: true });
    });
  });

  // ==================== getMessageStats ====================

  describe('getMessageStats', () => {
    it('should return zeros when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getMessageStats(0, Date.now());

      expect(result).toEqual({ total: 0, success: 0, failed: 0, avgDuration: 0, avgTtft: 0 });
    });

    it('should return aggregated stats', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const rpcResult = {
        data: [
          {
            total_messages: 10,
            success_count: 8,
            failure_count: 2,
            avg_duration: 1500,
            avg_ttft: 420,
          },
        ],
        error: null,
      };
      mockSupabaseClient.rpc.mockReturnValue(Promise.resolve(rpcResult));

      const result = await repository.getMessageStats(Date.now() - 3600000, Date.now());

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
        'get_dashboard_overview_stats',
        expect.objectContaining({
          p_start_date: expect.any(String),
          p_end_date: expect.any(String),
        }),
      );
      expect(result).toEqual({
        total: 10,
        success: 8,
        failed: 2,
        avgDuration: 1500,
        avgTtft: 420,
      });
    });

    it('should calculate filtered stats without RPC', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({
        data: [
          { status: 'success', total_duration: 1000, ttft_ms: '120' },
          { status: 'failure', total_duration: 500, ttft_ms: null },
          { status: 'timeout', total_duration: 0, ttft_ms: '' },
        ],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getMessageStats(Date.now() - 3600000, Date.now(), {
        userName: 'Alice',
        managerNames: ['LiHanTing'],
      });

      expect(mockSupabaseClient.rpc).not.toHaveBeenCalled();
      expect(queryMock.ilike).toHaveBeenCalledWith('user_name', '%Alice%');
      expect(queryMock.ilike).toHaveBeenCalledWith('manager_name', '%LiHanTing%');
      expect(result).toEqual({
        total: 3,
        success: 1,
        failed: 2,
        avgDuration: 750,
        avgTtft: 120,
      });
    });
  });

  // ==================== getActiveUsers ====================

  describe('getActiveUsers', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getActiveUsers(new Date(), new Date());

      expect(result).toEqual([]);
    });

    it('should return aggregated user data from RPC', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const now = new Date().toISOString();
      const rpcRows = [
        {
          user_id: 'user_001',
          user_name: 'Alice',
          chat_id: 'chat_001',
          message_count: '2',
          token_usage: '150',
          first_active_at: now,
          last_active_at: now,
        },
        {
          user_id: 'user_002',
          user_name: 'Bob',
          chat_id: 'chat_002',
          message_count: '1',
          token_usage: '75',
          first_active_at: now,
          last_active_at: now,
        },
      ];

      mockSupabaseClient.rpc.mockResolvedValue({ data: rpcRows, error: null });

      const result = await repository.getActiveUsers(new Date(), new Date());

      expect(result).toHaveLength(2);
      expect(result[0].userId).toBe('user_001');
      expect(result[0].messageCount).toBe(2);
      expect(result[0].tokenUsage).toBe(150);
      expect(result[1].userId).toBe('user_002');
    });

    it('should return empty array when RPC returns null', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      const result = await repository.getActiveUsers(new Date(), new Date());

      expect(result).toEqual([]);
    });
  });

  // ==================== getDailyUserStats ====================

  describe('getDailyUserStats', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getDailyUserStats(new Date(), new Date());

      expect(result).toEqual([]);
    });

    it('should return pre-aggregated stats from RPC', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const rpcRows = [
        { stat_date: '2026-03-10', unique_users: '2', message_count: '3', token_usage: '225' },
        { stat_date: '2026-03-11', unique_users: '1', message_count: '1', token_usage: '200' },
      ];

      mockSupabaseClient.rpc.mockResolvedValue({ data: rpcRows, error: null });

      const result = await repository.getDailyUserStats(new Date(), new Date());

      expect(result).toHaveLength(2);
      const day10 = result.find((d) => d.date === '2026-03-10');
      expect(day10?.messageCount).toBe(3);
      expect(day10?.uniqueUsers).toBe(2);
      expect(day10?.tokenUsage).toBe(225);
    });
  });

  // ==================== getRecordsByTimeRange ====================

  describe('getRecordsByTimeRange', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getRecordsByTimeRange(0, Date.now());

      expect(result).toEqual([]);
    });

    it('should return mapped records', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const now = Date.now();
      const dbRow = {
        message_id: 'msg_001',
        chat_id: 'chat_001',
        user_id: 'user_001',
        user_name: 'Alice',
        manager_name: 'Bob',
        received_at: new Date(now).toISOString(),
        message_preview: 'Test msg',
        reply_preview: 'Test reply',
        reply_segments: null,
        status: 'success',
        error: null,
        scenario: null,
        total_duration: 1500,
        queue_duration: null,
        prep_duration: null,
        ai_start_at: null,
        ai_end_at: null,
        ai_duration: 1200,
        send_duration: null,
        token_usage: 80,
        is_fallback: false,
        fallback_success: null,
        agent_invocation: null,
        batch_id: null,
      };

      const queryMock = makeQueryMock({ data: [dbRow], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getRecordsByTimeRange(now - 3600000, now);

      expect(result).toHaveLength(1);
      expect(result[0].messageId).toBe('msg_001');
    });
  });

  // ==================== cleanupMessageProcessingRecords ====================

  describe('cleanupMessageProcessingRecords', () => {
    it('should return 0 when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.cleanupMessageProcessingRecords(14);

      expect(result).toBe(0);
    });

    it('should return deleted count from RPC', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [{ deleted_count: '35' }],
        error: null,
      });

      const result = await repository.cleanupMessageProcessingRecords(14);

      expect(result).toBe(35);
      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('cleanup_message_processing_records', {
        days_to_keep: 14,
      });
    });

    it('should return 0 when RPC returns error (BaseRepository.rpc swallows errors and returns null)', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      // BaseRepository.rpc() catches errors internally via handleError() and returns null.
      // cleanupMessageProcessingRecords() receives null from rpc(), not a thrown error.
      mockSupabaseClient.rpc.mockResolvedValue({
        data: null,
        error: { message: 'RPC failed', code: '42P01' },
      });

      const result = await repository.cleanupMessageProcessingRecords(14);

      expect(result).toBe(0);
    });
  });

  // ==================== nullAgentInvocations ====================

  describe('nullAgentInvocations', () => {
    it('should return 0 when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.nullAgentInvocations(7);

      expect(result).toBe(0);
    });

    it('should return updated count from RPC (legacy row-set shape)', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({
        data: [{ null_agent_invocation: '20' }],
        error: null,
      });

      const result = await repository.nullAgentInvocations(7);

      expect(result).toBe(20);
    });

    it('should loop batches until a batch returns less than the limit', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      // 两条并行清理：子表 delete_expired_agent_invocations 分批删，主表 null_agent_invocation 置空存量。
      // returns integer 的函数 supabase-js 返回裸数字；按函数名分别计数。
      const calls: Record<string, number> = {};
      mockSupabaseClient.rpc.mockImplementation((fn: string) => {
        calls[fn] = (calls[fn] ?? 0) + 1;
        if (fn === 'delete_expired_agent_invocations') {
          return Promise.resolve({ data: calls[fn] <= 2 ? 200 : 35, error: null });
        }
        return Promise.resolve({ data: calls[fn] === 1 ? 20 : 0, error: null });
      });

      const result = await repository.nullAgentInvocations(7);

      // 子表 200+200+35 = 435（第 3 批 < limit 停止），主表 20（< limit 停止）
      expect(result).toBe(455);
      expect(calls['delete_expired_agent_invocations']).toBe(3);
      expect(calls['null_agent_invocation']).toBe(1);
    });

    it('should use default daysOld of 7 and pass batch limit', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: 0, error: null });

      await repository.nullAgentInvocations();

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('null_agent_invocation', {
        p_days_old: 7,
        p_limit: 200,
      });
    });
  });

  // ==================== interruptStalePostProcessing ====================

  describe('interruptStalePostProcessing', () => {
    it('should skip when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.interruptStalePostProcessing();

      expect(result).toBe(0);
      expect(mockSupabaseClient.rpc).not.toHaveBeenCalled();
    });

    it('should mark stale running post-processing as interrupted', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: 3, error: null });

      const result = await repository.interruptStalePostProcessing(30);

      expect(result).toBe(3);
      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('interrupt_stale_post_processing', {
        p_stale_minutes: 30,
        p_limit: 200,
      });
    });
  });

  // ==================== timeoutStuckRecords ====================

  describe('timeoutStuckRecords', () => {
    it('should return 0 when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.timeoutStuckRecords(30);

      expect(result).toBe(0);
      expect(mockSupabaseClient.rpc).not.toHaveBeenCalled();
    });

    it('should mark stuck records via stage-attribution RPC', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: 4, error: null });

      const result = await repository.timeoutStuckRecords(30);

      expect(result).toBe(4);
      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('timeout_stuck_records', {
        p_stuck_minutes: 30,
        p_limit: 500,
      });
    });

    it('should loop batches until a batch returns less than the limit', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc
        .mockResolvedValueOnce({ data: 500, error: null })
        .mockResolvedValueOnce({ data: 12, error: null });

      const result = await repository.timeoutStuckRecords(30);

      expect(result).toBe(512);
      expect(mockSupabaseClient.rpc).toHaveBeenCalledTimes(2);
    });

    it('should return 0 (not throw) on RPC error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockRejectedValue(new Error('DB error'));

      await expect(repository.timeoutStuckRecords(30)).resolves.toBe(0);
    });
  });

  // ==================== markSupersededProcessingRecords ====================

  describe('markSupersededProcessingRecords', () => {
    it('should return 0 when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.markSupersededProcessingRecords({
        currentMessageId: 'batch-new',
        replacementMessageId: 'batch-new',
        chatId: 'chat-1',
        receivedAt: 1700000000000,
        messagePreview: 'hello',
      });

      expect(result).toBe(0);
      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should mark stale processing siblings as superseded by the replacement batch', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updateResult = makeQueryMock({
        data: [{ message_id: 'batch-old-1' }, { message_id: 'batch-old-2' }],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      const result = await repository.markSupersededProcessingRecords({
        currentMessageId: 'batch-new',
        replacementMessageId: 'batch-new',
        chatId: 'chat-1',
        receivedAt: 1700000000000,
        messagePreview: 'hello',
      });

      expect(result).toBe(2);
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('message_processing_records');
      expect(updateResult.update).toHaveBeenCalledWith({
        status: 'timeout',
        error: '发布/重试中断遗留记录，已由 batch-new 补处理成功',
        batch_id: 'batch-new',
      });
      expect(updateResult.eq).toHaveBeenCalledWith('status', 'processing');
      expect(updateResult.eq).toHaveBeenCalledWith('chat_id', 'chat-1');
      expect(updateResult.eq).toHaveBeenCalledWith(
        'received_at',
        new Date(1700000000000).toISOString(),
      );
      expect(updateResult.eq).toHaveBeenCalledWith('message_preview', 'hello');
      expect(updateResult.neq).toHaveBeenCalledWith('message_id', 'batch-new');
      expect(updateResult.select).toHaveBeenCalledWith('message_id');
    });
  });

  // ==================== clearAllRecords ====================

  describe('clearAllRecords', () => {
    it('should skip when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      await repository.clearAllRecords();

      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should delete all records when supabase is available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const deleteResult = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(deleteResult);

      await expect(repository.clearAllRecords()).resolves.not.toThrow();

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('message_processing_records');
    });
  });
});

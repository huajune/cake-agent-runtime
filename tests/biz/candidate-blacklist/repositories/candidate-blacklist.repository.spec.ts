import { Test, TestingModule } from '@nestjs/testing';
import { CandidateBlacklistRepository } from '@biz/candidate-blacklist/repositories/candidate-blacklist.repository';
import { CandidateBlacklistRecord } from '@biz/candidate-blacklist/entities/candidate-blacklist.entity';
import { SupabaseService } from '@infra/supabase/supabase.service';

/**
 * Helper: create a chainable Supabase query mock that resolves to a given result.
 */
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

function makeRecord(overrides: Partial<CandidateBlacklistRecord> = {}): CandidateBlacklistRecord {
  return {
    id: 'uuid-001',
    target_id: 'wmAbc_001',
    reason: '恶意骚扰',
    operator: '小王',
    chat_id: 'chat_001',
    im_contact_id: 'contact_001',
    contact_name: '张三',
    source: 'manual',
    hit_count: 0,
    last_hit_at: null,
    last_hit_chat_id: null,
    last_hit_bot_id: null,
    last_hit_message_id: null,
    created_at: '2026-06-10T00:00:00.000Z',
    updated_at: '2026-06-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('CandidateBlacklistRepository', () => {
  let repository: CandidateBlacklistRepository;

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
        CandidateBlacklistRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<CandidateBlacklistRepository>(CandidateBlacklistRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== findAll ====================

  describe('findAll', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.findAll();

      expect(result).toEqual([]);
      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should return records ordered by created_at desc', async () => {
      const records = [
        makeRecord({ target_id: 'wmAbc_002', created_at: '2026-06-11T00:00:00.000Z' }),
        makeRecord({ target_id: 'wmAbc_001' }),
      ];
      const queryMock = makeQueryMock({ data: records, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findAll();

      expect(result).toEqual(records);
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('candidate_blacklist');
      expect(queryMock.order).toHaveBeenCalledWith('created_at', { ascending: false });
    });

    it('should return empty array when table is empty', async () => {
      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findAll();

      expect(result).toEqual([]);
    });

    it('should return empty array on database error', async () => {
      const queryMock = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findAll();

      expect(result).toEqual([]);
    });
  });

  // ==================== upsertItem ====================

  describe('upsertItem', () => {
    it('should upsert with target_id conflict key and snake_case payload', async () => {
      const queryMock = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      await repository.upsertItem({
        targetId: 'wmAbc_001',
        reason: '恶意骚扰',
        operator: '小王',
        chatId: 'chat_001',
        imContactId: 'contact_001',
        contactName: '张三',
        source: 'api',
      });

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('candidate_blacklist');
      expect(queryMock.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          target_id: 'wmAbc_001',
          reason: '恶意骚扰',
          operator: '小王',
          chat_id: 'chat_001',
          im_contact_id: 'contact_001',
          contact_name: '张三',
          source: 'api',
          updated_at: expect.any(String),
        }),
        { onConflict: 'target_id' },
      );
    });

    it('should fill defaults (null snapshot fields, manual source) for minimal params', async () => {
      const queryMock = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      await repository.upsertItem({ targetId: 'wmAbc_002', reason: '已入职竞对' });

      expect(queryMock.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          target_id: 'wmAbc_002',
          reason: '已入职竞对',
          operator: null,
          chat_id: null,
          im_contact_id: null,
          contact_name: null,
          source: 'manual',
        }),
        { onConflict: 'target_id' },
      );
    });

    it('should not throw on conflict-update path (existing target_id)', async () => {
      // PostgREST 对 onConflict 命中的行执行 UPDATE，客户端侧同样返回成功结果
      const queryMock = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      await expect(
        repository.upsertItem({ targetId: 'wmAbc_001', reason: '更新后的理由', operator: '小李' }),
      ).resolves.not.toThrow();

      expect(queryMock.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ target_id: 'wmAbc_001', reason: '更新后的理由' }),
        { onConflict: 'target_id' },
      );
    });

    it('should skip and not throw when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      await expect(
        repository.upsertItem({ targetId: 'wmAbc_001', reason: '恶意骚扰' }),
      ).resolves.not.toThrow();

      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should not throw on database error', async () => {
      const queryMock = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '23502' },
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      await expect(
        repository.upsertItem({ targetId: 'wmAbc_001', reason: '恶意骚扰' }),
      ).resolves.not.toThrow();
    });
  });

  // ==================== deleteByTargetId ====================

  describe('deleteByTargetId', () => {
    it('should return 0 when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.deleteByTargetId('wmAbc_001');

      expect(result).toBe(0);
      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should return deleted row count when target exists', async () => {
      const queryMock = makeQueryMock({ data: [{ target_id: 'wmAbc_001' }], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.deleteByTargetId('wmAbc_001');

      expect(result).toBe(1);
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('candidate_blacklist');
      expect(queryMock.delete).toHaveBeenCalled();
      expect(queryMock.eq).toHaveBeenCalledWith('target_id', 'wmAbc_001');
    });

    it('should return 0 when target is not in blacklist', async () => {
      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.deleteByTargetId('wmAbc_unknown');

      expect(result).toBe(0);
    });

    it('should return 0 on database error', async () => {
      const queryMock = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.deleteByTargetId('wmAbc_001');

      expect(result).toBe(0);
    });
  });

  // ==================== recordHit ====================

  describe('recordHit', () => {
    it('should call RPC with target id and hit snapshot', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      await repository.recordHit('wmAbc_001', {
        chatId: 'chat_001',
        botId: 'bot_001',
        messageId: 'msg_001',
      });

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('record_candidate_blacklist_hit', {
        p_target_id: 'wmAbc_001',
        p_chat_id: 'chat_001',
        p_bot_id: 'bot_001',
        p_message_id: 'msg_001',
      });
    });

    it('should pass nulls for missing hit snapshot fields', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      await repository.recordHit('wmAbc_001', {});

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('record_candidate_blacklist_hit', {
        p_target_id: 'wmAbc_001',
        p_chat_id: null,
        p_bot_id: null,
        p_message_id: null,
      });
    });

    it('should skip RPC when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      await repository.recordHit('wmAbc_001', { chatId: 'chat_001' });

      expect(mockSupabaseClient.rpc).not.toHaveBeenCalled();
    });

    it('should only log and not throw when RPC returns an error', async () => {
      mockSupabaseClient.rpc.mockResolvedValue({
        data: null,
        error: { message: 'function error', code: 'P0001' },
      });

      await expect(
        repository.recordHit('wmAbc_001', { chatId: 'chat_001' }),
      ).resolves.not.toThrow();
    });

    it('should only log and not throw when RPC call rejects', async () => {
      mockSupabaseClient.rpc.mockRejectedValue(new Error('connection refused'));

      await expect(
        repository.recordHit('wmAbc_001', { chatId: 'chat_001' }),
      ).resolves.not.toThrow();
    });
  });
});

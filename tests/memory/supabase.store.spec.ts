import { SupabaseStore } from '@memory/stores/supabase.store';

describe('SupabaseStore', () => {
  const mockRedis = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    setex: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(1),
  };

  const mockMaybeSingle = jest.fn();
  const mockEqChain = {
    eq: jest.fn().mockReturnThis(),
    maybeSingle: mockMaybeSingle,
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  };
  const mockSelect = jest.fn().mockReturnValue(mockEqChain);
  const mockUpsert = jest.fn().mockResolvedValue({ error: null });
  const mockDelete = jest.fn().mockReturnValue({
    eq: jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    }),
  });
  const mockRpc = jest.fn();

  const mockSupabaseClient = {
    from: jest.fn().mockReturnValue({
      select: mockSelect,
      upsert: mockUpsert,
      delete: mockDelete,
    }),
    rpc: mockRpc,
  };

  const mockSupabaseService = {
    getSupabaseClient: jest.fn().mockReturnValue(mockSupabaseClient),
  };

  let store: SupabaseStore;

  const profileFact = <T>(
    value: T,
    overrides: Partial<{
      confidence: 'high' | 'medium' | 'low' | 'unknown';
      source: 'booking' | 'extraction' | 'enrichment';
      evidence: string;
      updatedAt: string;
    }> = {},
  ) => ({
    value,
    confidence: overrides.confidence ?? ('high' as const),
    source: overrides.source ?? ('booking' as const),
    evidence: overrides.evidence ?? '测试写入',
    updatedAt: overrides.updatedAt ?? '2026-05-22T10:00:00.000Z',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabaseService.getSupabaseClient.mockReturnValue(mockSupabaseClient);
    const mockConfig = { longTermCacheTtl: 7200 };
    store = new SupabaseStore(
      mockSupabaseService as never,
      mockRedis as never,
      mockConfig as never,
    );
  });

  describe('getProfile', () => {
    it('should return from Redis cache if available', async () => {
      const cached = {
        profile_facts: {
          name: profileFact('张三'),
          phone: profileFact('138'),
          gender: null,
          age: null,
          is_student: null,
          education: null,
          has_health_certificate: null,
        },
      };
      mockRedis.get.mockResolvedValue(cached);

      const result = await store.getProfile('corp1', 'user1');

      expect(result).toEqual(cached.profile_facts);
    });

    it('should fallback to Supabase on cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValue({
        data: {
          profile_facts: {
            name: profileFact('张三'),
            phone: profileFact('138'),
            gender: null,
            age: null,
            is_student: null,
            education: null,
            has_health_certificate: null,
          },
        },
        error: null,
      });

      const result = await store.getProfile('corp1', 'user1');

      expect(result?.name?.value).toBe('张三');
      expect(result?.phone?.value).toBe('138');
      expect(mockRedis.setex).toHaveBeenCalled();
    });

    it('should return null when Supabase unavailable', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockSupabaseService.getSupabaseClient.mockReturnValue(null);

      const result = await store.getProfile('corp1', 'user1');

      expect(result).toBeNull();
    });
  });

  describe('getSummaryData', () => {
    it('should return null when no row exists', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValue({ data: null, error: null });

      const result = await store.getSummaryData('corp1', 'user1');

      expect(result).toBeNull();
    });

    it('should return summary_data from row', async () => {
      const summaryData = {
        recent: [
          { summary: 'test', sessionId: 's1', startTime: '2026-03-15', endTime: '2026-03-15' },
        ],
        archive: null,
      };
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValue({
        data: { summary_data: summaryData },
        error: null,
      });

      const result = await store.getSummaryData('corp1', 'user1');

      expect(result).toEqual({ ...summaryData, lastSettledMessageAt: null });
    });
  });

  describe('appendSummary', () => {
    it('passes summary entry as json object to atomic RPC', async () => {
      mockRpc.mockResolvedValue({
        data: { overflow: [], recentCount: 1 },
        error: null,
      });

      const entry = {
        summary: '候选人想约明天',
        sessionId: 'sess-1',
        startTime: '2026-05-27T10:00:00.000Z',
        endTime: '2026-05-27T10:05:00.000Z',
      };

      await store.appendSummary('corp1', 'user1', entry, {
        lastSettledMessageAt: entry.endTime,
      });

      expect(mockRpc).toHaveBeenCalledWith('append_long_term_summary_atomic', {
        p_corp_id: 'corp1',
        p_user_id: 'user1',
        p_entry: entry,
        p_last_settled_message_at: entry.endTime,
        p_max_recent: 5,
      });
      expect(mockRedis.del).toHaveBeenCalledWith('long-term:corp1:user1');
    });
  });

  describe('upsertProfileFacts', () => {
    it('should call RPC with profile facts and message_metadata', async () => {
      mockRpc.mockResolvedValue({
        data: { written_fields: ['name', 'phone'], skipped_fields: [] },
        error: null,
      });

      const name = profileFact('张三');
      const phone = profileFact('13800138000');
      await store.upsertProfileFacts('corp1', 'user1', { name, phone }, { botId: 'bot-1' });

      expect(mockRpc).toHaveBeenCalledWith('upsert_long_term_profile_facts', {
        p_corp_id: 'corp1',
        p_user_id: 'user1',
        p_profile_facts: { name, phone },
        p_message_metadata: { botId: 'bot-1' },
      });
    });

    it('should invalidate Redis cache after successful RPC', async () => {
      mockRpc.mockResolvedValue({
        data: { written_fields: ['name'], skipped_fields: [] },
        error: null,
      });

      await store.upsertProfileFacts('corp1', 'user1', { name: profileFact('张三') });

      expect(mockRedis.del).toHaveBeenCalledWith('long-term:corp1:user1');
    });

    it('should not call RPC when profile facts and metadata are empty', async () => {
      await store.upsertProfileFacts('corp1', 'user1', {});

      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('should filter null facts before calling RPC', async () => {
      mockRpc.mockResolvedValue({
        data: { written_fields: ['phone'], skipped_fields: [] },
        error: null,
      });

      const phone = profileFact('138');
      await store.upsertProfileFacts('corp1', 'user1', { name: null, phone });

      expect(mockRpc).toHaveBeenCalledWith(
        'upsert_long_term_profile_facts',
        expect.objectContaining({
          p_profile_facts: { phone },
        }),
      );
    });

    it('should handle RPC error gracefully without crashing', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC not found' } });

      await expect(
        store.upsertProfileFacts('corp1', 'user1', { name: profileFact('张三') }),
      ).resolves.toBeUndefined();

      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('should pass null for message_metadata when not provided', async () => {
      mockRpc.mockResolvedValue({
        data: { written_fields: ['name'], skipped_fields: [] },
        error: null,
      });

      await store.upsertProfileFacts('corp1', 'user1', { name: profileFact('张三') });

      expect(mockRpc).toHaveBeenCalledWith(
        'upsert_long_term_profile_facts',
        expect.objectContaining({ p_message_metadata: null }),
      );
    });

    it('should pass metadata-only updates to RPC', async () => {
      mockRpc.mockResolvedValue({
        data: { written_fields: [], skipped_fields: [] },
        error: null,
      });

      await store.upsertProfileFacts('corp1', 'user1', {}, { botId: 'bot-1' });

      expect(mockRpc).toHaveBeenCalledWith(
        'upsert_long_term_profile_facts',
        expect.objectContaining({
          p_profile_facts: {},
          p_message_metadata: { botId: 'bot-1' },
        }),
      );
    });

    it('should delegate confidence guard to atomic DB RPC, not app-level read-then-write', async () => {
      // 回归场景：settlement 先读（无 high）→ booking 写 high → settlement 后写 medium
      // 应用层 read-then-write 无法防止此交错。验证走 RPC 而非 from().upsert()。
      mockRpc.mockResolvedValue({
        data: { written_fields: ['education'], skipped_fields: ['name', 'phone', 'age', 'gender'] },
        error: null,
      });

      await store.upsertProfileFacts('corp1', 'user1', {
        name: profileFact('李四', { source: 'extraction', confidence: 'medium' }),
        phone: profileFact('139', { source: 'extraction', confidence: 'medium' }),
        age: profileFact('25', { source: 'extraction', confidence: 'medium' }),
        gender: profileFact('女', { source: 'extraction', confidence: 'medium' }),
        education: profileFact('本科', { source: 'extraction', confidence: 'medium' }),
      });

      // 关键断言：走 RPC（原子），而非 from().upsert()（非原子）
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith(
        'upsert_long_term_profile_facts',
        expect.objectContaining({ p_corp_id: 'corp1' }),
      );
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });

  describe('set (v1 compat)', () => {
    it('should delegate profile writes to upsertProfileFacts', async () => {
      mockRpc.mockResolvedValue({
        data: { written_fields: ['name'], skipped_fields: [] },
        error: null,
      });

      await store.set('profile:corp1:user1', { name: '张三' });

      expect(mockRpc).toHaveBeenCalledWith(
        'upsert_long_term_profile_facts',
        expect.objectContaining({
          p_profile_facts: {
            name: expect.objectContaining({
              value: '张三',
              source: 'enrichment',
              confidence: 'medium',
            }),
          },
        }),
      );
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });

  describe('upsertMessageMetadata', () => {
    it('should upsert compact message metadata and invalidate cache', async () => {
      await store.upsertMessageMetadata('corp1', 'user1', {
        botId: 'bot-1',
        imBotId: 'im-bot-1',
        imContactId: 'im-contact-1',
        contactType: 1,
        contactName: '候选人',
        externalUserId: '',
        avatar: undefined,
      });

      expect(mockUpsert).toHaveBeenCalledWith(
        {
          corp_id: 'corp1',
          user_id: 'user1',
          message_metadata: {
            botId: 'bot-1',
            imBotId: 'im-bot-1',
            imContactId: 'im-contact-1',
            contactType: 1,
            contactName: '候选人',
          },
          updated_at: expect.any(String),
        },
        { onConflict: 'corp_id,user_id' },
      );
      expect(mockRedis.del).toHaveBeenCalledWith('long-term:corp1:user1');
    });

    it('should skip empty message metadata', async () => {
      await store.upsertMessageMetadata('corp1', 'user1', {
        contactName: '',
      });

      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });

  describe('del (v1 compat)', () => {
    it('should delete from Redis cache', async () => {
      await store.del('profile:corp1:user1');

      expect(mockRedis.del).toHaveBeenCalledWith('long-term:corp1:user1');
    });
  });
});

import { SupabaseStore } from '@memory/stores/supabase.store';
import { UserProfileFactValueSchema } from '@memory/long-term/long-term.types';
import type { CandidateFactProducer } from '@resolution/evidence/claim.types';

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
      confidence: 'high' | 'medium';
      source: CandidateFactProducer;
      evidence: string;
      updatedAt: string;
    }> = {},
  ) => ({
    value,
    confidence: overrides.confidence ?? ('high' as const),
    source: overrides.source ?? ('system' as const),
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

  describe('profile fact source compatibility', () => {
    it.each([
      ['candidate', 'candidate_quote'],
      ['llm', 'model'],
      ['derived', 'rule'],
      ['system', 'system'],
      ['tool', 'system'],
      ['memory', 'archive'],
      ['rule', 'rule'],
      ['booking', 'system'],
      ['enrichment', 'system'],
      ['extraction', 'archive'],
    ] as const)('normalizes legacy %s to %s at the schema boundary', (source, expected) => {
      expect(
        UserProfileFactValueSchema.parse({
          value: '张三',
          confidence: 'medium',
          source,
          evidence: 'legacy',
          updatedAt: '2026-05-22T10:00:00.000Z',
        }).source,
      ).toBe(expected);
    });
  });

  describe('getProfile', () => {
    it('should return from Redis cache if available', async () => {
      const cached = {
        semantic_profile: {
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

      expect(result).toEqual(cached.semantic_profile);
    });

    it('should fallback to Supabase on cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValue({
        data: {
          semantic_profile: {
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

  describe('getSessionSummaries', () => {
    it('should return null when no row exists', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValue({ data: null, error: null });

      const result = await store.getSessionSummaries('corp1', 'user1');

      expect(result).toBeNull();
    });

    it('should return episodic_session_summaries from row', async () => {
      const sessionSummaries = {
        recent: [
          { summary: 'test', sessionId: 's1', startTime: '2026-03-15', endTime: '2026-03-15' },
        ],
        archive: null,
      };
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValue({
        data: { episodic_session_summaries: sessionSummaries },
        error: null,
      });

      const result = await store.getSessionSummaries('corp1', 'user1');

      expect(result).toEqual({
        ...sessionSummaries,
        lastSettledMessageAt: null,
        lastSettledBySession: null,
      });
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
        p_session_id: null,
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
        p_preference_facts: null,
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

    it('preference 墓碑对象作为非空第五参传入 RPC', async () => {
      mockRpc.mockResolvedValue({ data: { written_fields: [], skipped_fields: [] }, error: null });
      const tombstone = profileFact(null, {
        confidence: 'medium',
        source: 'candidate_quote',
        evidence: '候选人明确清空地点偏好',
      });

      await store.upsertProfileFacts('corp1', 'user1', {}, undefined, {
        location: tombstone,
      });

      expect(mockRpc).toHaveBeenCalledWith(
        'upsert_long_term_profile_facts',
        expect.objectContaining({ p_preference_facts: { location: tombstone } }),
      );
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
      // 回归场景：consolidation 先读（无 high）→ booking 写 high → consolidation 后写 medium
      // 应用层 read-then-write 无法防止此交错。验证走 RPC 而非 from().upsert()。
      mockRpc.mockResolvedValue({
        data: { written_fields: ['education'], skipped_fields: ['name', 'phone', 'age', 'gender'] },
        error: null,
      });

      await store.upsertProfileFacts('corp1', 'user1', {
        name: profileFact('李四', { source: 'archive', confidence: 'medium' }),
        phone: profileFact('139', { source: 'archive', confidence: 'medium' }),
        age: profileFact('25', { source: 'archive', confidence: 'medium' }),
        gender: profileFact('女', { source: 'archive', confidence: 'medium' }),
        education: profileFact('本科', { source: 'archive', confidence: 'medium' }),
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
              source: 'system',
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

  // 议题 3-3：单数读 API 已删除，"最近一笔 = getActiveBookings()[0]" 由调用方直接依赖。
  // 该等价关系此前只存在于 store 实现的约定里（getActiveBooking = bookings[0] ?? null），
  // 这里在三种存量 JSONB 形态上把它锁死。
  describe('getActiveBookings 的存量形态与"最近一笔=[0]"等价性（议题 3-3）', () => {
    const readWith = async (activeBooking: unknown) => {
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValue({ data: { active_booking: activeBooking }, error: null });
      return store.getActiveBookings('corp1', 'user1');
    };

    it('null 形态：返回空列表，[0] 为 undefined', async () => {
      const bookings = await readWith(null);

      expect(bookings).toEqual([]);
      expect(bookings[0]).toBeUndefined();
    });

    it('老单笔形态（顶层字段、无 bookings）：唯一一笔即 [0]', async () => {
      const bookings = await readWith({
        work_order_id: 5001,
        linked_at: '2026-04-15T00:00:00.000Z',
        job_id: 900,
      });

      expect(bookings).toEqual([
        { work_order_id: 5001, linked_at: '2026-04-15T00:00:00.000Z', job_id: 900 },
      ]);
    });

    it('新列表形态：按 linked_at 倒序，[0] 是最近一笔且与顶层镜像去重', async () => {
      const bookings = await readWith({
        work_order_id: 5002,
        linked_at: '2026-04-16T00:00:00.000Z',
        job_id: 902,
        bookings: [
          { work_order_id: 5002, linked_at: '2026-04-16T00:00:00.000Z', job_id: 902 },
          { work_order_id: 5001, linked_at: '2026-04-15T00:00:00.000Z', job_id: 900 },
        ],
      });

      expect(bookings.map((booking) => booking.work_order_id)).toEqual([5002, 5001]);
      expect(bookings[0]).toEqual({
        work_order_id: 5002,
        linked_at: '2026-04-16T00:00:00.000Z',
        job_id: 902,
      });
    });
  });
});

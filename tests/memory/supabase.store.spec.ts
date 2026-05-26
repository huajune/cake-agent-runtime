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

  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabaseService.getSupabaseClient.mockReturnValue(mockSupabaseClient);
    const mockConfig = { longTermCacheTtl: 7200 };
    store = new SupabaseStore(mockSupabaseService as never, mockRedis as never, mockConfig as never);
  });

  describe('getProfile', () => {
    it('should return from Redis cache if available', async () => {
      const cached = { name: '张三', phone: '138', gender: null, age: null, is_student: null, education: null, has_health_certificate: null };
      mockRedis.get.mockResolvedValue(cached);

      const result = await store.getProfile('corp1', 'user1');

      expect(result).toEqual(cached);
    });

    it('should fallback to Supabase on cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValue({
        data: { name: '张三', phone: '138', gender: null, age: null, is_student: null, education: null, has_health_certificate: null },
        error: null,
      });

      const result = await store.getProfile('corp1', 'user1');

      expect(result).toEqual(expect.objectContaining({ name: '张三', phone: '138' }));
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

  describe('upsertProfileWithMeta', () => {
    it('should call RPC with profile, meta, and message_metadata', async () => {
      mockRpc.mockResolvedValue({
        data: { written_fields: ['name', 'phone'], skipped_fields: [] },
        error: null,
      });

      const bookingMeta = { source: 'booking' as const, confidence: 'high' as const, writtenAt: '2026-05-22T10:00:00.000Z' };
      await store.upsertProfileWithMeta(
        'corp1',
        'user1',
        { name: '张三', phone: '13800138000' },
        { name: bookingMeta, phone: bookingMeta },
        { botId: 'bot-1' },
      );

      expect(mockRpc).toHaveBeenCalledWith('upsert_profile_with_confidence_guard', {
        p_corp_id: 'corp1',
        p_user_id: 'user1',
        p_profile: { name: '张三', phone: '13800138000' },
        p_meta: { name: bookingMeta, phone: bookingMeta },
        p_message_metadata: { botId: 'bot-1' },
      });
    });

    it('should invalidate Redis cache after successful RPC', async () => {
      mockRpc.mockResolvedValue({
        data: { written_fields: ['name'], skipped_fields: [] },
        error: null,
      });

      const meta = { name: { source: 'booking' as const, confidence: 'high' as const, writtenAt: '2026-05-22T10:00:00.000Z' } };
      await store.upsertProfileWithMeta('corp1', 'user1', { name: '张三' }, meta);

      expect(mockRedis.del).toHaveBeenCalledWith('profile:corp1:user1');
    });

    it('should not call RPC when profile and meta are both empty', async () => {
      await store.upsertProfileWithMeta('corp1', 'user1', {}, {});

      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('should filter null values from profile before calling RPC', async () => {
      mockRpc.mockResolvedValue({
        data: { written_fields: ['phone'], skipped_fields: [] },
        error: null,
      });

      const meta = { phone: { source: 'booking' as const, confidence: 'high' as const, writtenAt: '2026-05-22T10:00:00.000Z' } };
      await store.upsertProfileWithMeta('corp1', 'user1', { name: null, phone: '138' } as never, meta);

      expect(mockRpc).toHaveBeenCalledWith(
        'upsert_profile_with_confidence_guard',
        expect.objectContaining({
          p_profile: { phone: '138' },
        }),
      );
    });

    it('should handle RPC error gracefully without crashing', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'RPC not found' } });

      const meta = { name: { source: 'booking' as const, confidence: 'high' as const, writtenAt: '2026-05-22T10:00:00.000Z' } };
      await expect(
        store.upsertProfileWithMeta('corp1', 'user1', { name: '张三' }, meta),
      ).resolves.toBeUndefined();

      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('should pass null for message_metadata when not provided', async () => {
      mockRpc.mockResolvedValue({
        data: { written_fields: ['name'], skipped_fields: [] },
        error: null,
      });

      const meta = { name: { source: 'booking' as const, confidence: 'high' as const, writtenAt: '2026-05-22T10:00:00.000Z' } };
      await store.upsertProfileWithMeta('corp1', 'user1', { name: '张三' }, meta);

      expect(mockRpc).toHaveBeenCalledWith(
        'upsert_profile_with_confidence_guard',
        expect.objectContaining({ p_message_metadata: null }),
      );
    });

    it('should delegate confidence guard to atomic DB RPC, not app-level read-then-write', async () => {
      // 回归场景：settlement 先读（无 high）→ booking 写 high → settlement 后写 medium
      // 应用层 read-then-write 无法防止此交错。验证走 RPC 而非 from().upsert()。
      mockRpc.mockResolvedValue({
        data: { written_fields: ['education'], skipped_fields: ['name', 'phone', 'age', 'gender'] },
        error: null,
      });

      const extractionMeta = { source: 'extraction' as const, confidence: 'medium' as const, writtenAt: '2026-05-22T10:00:00.000Z' };
      await store.upsertProfileWithMeta(
        'corp1',
        'user1',
        { name: '李四', phone: '139', age: '25', gender: '女', education: '本科' },
        {
          name: extractionMeta,
          phone: extractionMeta,
          age: extractionMeta,
          gender: extractionMeta,
          education: extractionMeta,
        },
      );

      // 关键断言：走 RPC（原子），而非 from().upsert()（非原子）
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith(
        'upsert_profile_with_confidence_guard',
        expect.objectContaining({ p_corp_id: 'corp1' }),
      );
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });

  describe('del (v1 compat)', () => {
    it('should delete from Redis cache', async () => {
      await store.del('profile:corp1:user1');

      expect(mockRedis.del).toHaveBeenCalledWith('profile:corp1:user1');
    });
  });
});

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
  const mockUpdate = jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) });
  const mockInsert = jest.fn().mockResolvedValue({ error: null });
  const mockDelete = jest.fn().mockReturnValue({
    eq: jest.fn().mockReturnValue({
      eq: jest.fn().mockResolvedValue({ error: null }),
    }),
  });

  const mockSupabaseClient = {
    from: jest.fn().mockReturnValue({
      select: mockSelect,
      update: mockUpdate,
      insert: mockInsert,
      delete: mockDelete,
    }),
  };

  const mockSupabaseService = {
    getSupabaseClient: jest.fn().mockReturnValue(mockSupabaseClient),
  };

  let store: SupabaseStore;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabaseService.getSupabaseClient.mockReturnValue(mockSupabaseClient);
    const mockConfig = { profileCacheTtl: 7200 };
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
      const summaryData = { recent: [{ summary: 'test', sessionId: 's1', startTime: '2026-03-15', endTime: '2026-03-15' }], archive: null };
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValue({
        data: { summary_data: summaryData },
        error: null,
      });

      const result = await store.getSummaryData('corp1', 'user1');

      expect(result).toEqual(summaryData);
    });
  });

  describe('del (v1 compat)', () => {
    it('should delete from Redis cache', async () => {
      await store.del('profile:corp1:user1');

      expect(mockRedis.del).toHaveBeenCalledWith('profile:corp1:user1');
    });
  });
});

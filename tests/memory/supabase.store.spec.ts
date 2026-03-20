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
  };
  const mockSelect = jest.fn().mockReturnValue(mockEqChain);
  const mockUpsert = jest.fn();
  const mockDeleteEq = {
    eq: jest.fn().mockReturnThis(),
  };
  const mockDelete = jest.fn().mockReturnValue(mockDeleteEq);

  const mockSupabaseClient = {
    from: jest.fn().mockReturnValue({
      select: mockSelect,
      upsert: mockUpsert,
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

  describe('get', () => {
    it('should return from Redis cache if available', async () => {
      const entry = { key: 'profile_key', content: { pref: 'a' }, updatedAt: '2026-03-18' };
      mockRedis.get.mockResolvedValue(entry);

      const result = await store.get('profile:corp1:user1:pref');
      expect(result).toEqual(entry);
      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should fallback to Supabase on cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValue({
        data: {
          memory_key: 'pref',
          content: { style: 'formal' },
          updated_at: '2026-03-18',
        },
        error: null,
      });

      const result = await store.get('profile:corp1:user1:pref');
      expect(result).toEqual({
        key: 'pref',
        content: { style: 'formal' },
        updatedAt: '2026-03-18',
      });
      // Should backfill cache
      expect(mockRedis.setex).toHaveBeenCalled();
    });

    it('should return null when Supabase unavailable', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockSupabaseService.getSupabaseClient.mockReturnValue(null);

      const result = await store.get('profile:corp1:user1:pref');
      expect(result).toBeNull();
    });
  });

  describe('del', () => {
    it('should delete from both Redis and Supabase', async () => {
      // Mock the delete chain to resolve
      mockDeleteEq.eq.mockReturnThis();
      // The last .eq() returns an object with error
      const finalEq = jest.fn().mockResolvedValue({ error: null });
      mockDeleteEq.eq
        .mockReturnValueOnce(mockDeleteEq)
        .mockReturnValueOnce(mockDeleteEq)
        .mockReturnValueOnce({ error: null } as never);

      const result = await store.del('profile:corp1:user1:pref');
      expect(mockRedis.del).toHaveBeenCalled();
    });
  });
});

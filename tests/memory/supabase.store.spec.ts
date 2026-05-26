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
    it('should merge new meta with existing profile_fields_meta from DB', async () => {
      const existingMeta = {
        name: { source: 'extraction' as const, confidence: 'medium' as const, writtenAt: '2026-01-01T00:00:00.000Z' },
      };
      // getRow (select '*') → existing row with profile_fields_meta
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValueOnce({
        data: {
          name: '旧张三',
          phone: null,
          gender: null,
          age: null,
          is_student: null,
          education: null,
          has_health_certificate: null,
          profile_fields_meta: existingMeta,
        },
        error: null,
      });

      const newBookingMeta = {
        phone: { source: 'booking' as const, confidence: 'high' as const, writtenAt: '2026-05-22T10:00:00.000Z' },
      };
      await store.upsertProfileWithMeta('corp1', 'user1', { phone: '13800138000' }, newBookingMeta);

      // upsert should be called with merged meta: both 'name' (old) and 'phone' (new)
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          corp_id: 'corp1',
          user_id: 'user1',
          profile_fields_meta: {
            name: existingMeta.name,
            phone: newBookingMeta.phone,
          },
          phone: '13800138000',
        }),
        { onConflict: 'corp_id,user_id' },
      );
    });

    it('should write all profile fields and overwrite existing field meta', async () => {
      const existingMeta = {
        name: { source: 'extraction' as const, confidence: 'medium' as const, writtenAt: '2026-01-01T00:00:00.000Z' },
      };
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValueOnce({
        data: {
          name: '旧张三',
          phone: null,
          gender: null,
          age: null,
          is_student: null,
          education: null,
          has_health_certificate: null,
          profile_fields_meta: existingMeta,
        },
        error: null,
      });

      const bookingMeta = { source: 'booking' as const, confidence: 'high' as const, writtenAt: '2026-05-22T10:00:00.000Z' };
      await store.upsertProfileWithMeta(
        'corp1',
        'user1',
        { name: '张三', phone: '13800138000', age: '22', gender: '男' },
        { name: bookingMeta, phone: bookingMeta, age: bookingMeta, gender: bookingMeta },
      );

      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          name: '张三',
          phone: '13800138000',
          age: '22',
          gender: '男',
          profile_fields_meta: expect.objectContaining({
            name: bookingMeta,
            phone: bookingMeta,
            age: bookingMeta,
            gender: bookingMeta,
          }),
        }),
        { onConflict: 'corp_id,user_id' },
      );
    });

    it('should NOT let medium confidence overwrite high confidence fields', async () => {
      const existingMeta = {
        name: { source: 'booking' as const, confidence: 'high' as const, writtenAt: '2026-05-20T10:00:00.000Z' },
        phone: { source: 'booking' as const, confidence: 'high' as const, writtenAt: '2026-05-20T10:00:00.000Z' },
        age: { source: 'booking' as const, confidence: 'high' as const, writtenAt: '2026-05-20T10:00:00.000Z' },
        gender: { source: 'booking' as const, confidence: 'high' as const, writtenAt: '2026-05-20T10:00:00.000Z' },
      };
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValueOnce({
        data: {
          name: '张三',
          phone: '13800138000',
          gender: '男',
          age: '22',
          is_student: null,
          education: null,
          has_health_certificate: null,
          profile_fields_meta: existingMeta,
        },
        error: null,
      });

      const extractionMeta = { source: 'extraction' as const, confidence: 'medium' as const, writtenAt: '2026-05-22T10:00:00.000Z' };
      await store.upsertProfileWithMeta(
        'corp1',
        'user1',
        { name: '李四', phone: '13900139000', age: '25', gender: '女', education: '本科' },
        {
          name: extractionMeta,
          phone: extractionMeta,
          age: extractionMeta,
          gender: extractionMeta,
          education: extractionMeta,
        },
      );

      // Only education (no existing high-confidence) should be written
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          education: '本科',
          profile_fields_meta: expect.objectContaining({
            name: existingMeta.name,
            phone: existingMeta.phone,
            age: existingMeta.age,
            gender: existingMeta.gender,
            education: extractionMeta,
          }),
        }),
        { onConflict: 'corp_id,user_id' },
      );
      // Booking fields must NOT appear in upsert payload
      const upsertPayload = mockUpsert.mock.calls[0][0];
      expect(upsertPayload.name).toBeUndefined();
      expect(upsertPayload.phone).toBeUndefined();
      expect(upsertPayload.age).toBeUndefined();
      expect(upsertPayload.gender).toBeUndefined();
    });

    it('should skip upsert entirely when all fields are guarded by high confidence', async () => {
      const existingMeta = {
        name: { source: 'booking' as const, confidence: 'high' as const, writtenAt: '2026-05-20T10:00:00.000Z' },
      };
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValueOnce({
        data: {
          name: '张三',
          profile_fields_meta: existingMeta,
        },
        error: null,
      });

      const extractionMeta = { source: 'extraction' as const, confidence: 'medium' as const, writtenAt: '2026-05-22T10:00:00.000Z' };
      await store.upsertProfileWithMeta('corp1', 'user1', { name: '李四' }, { name: extractionMeta });

      // No upsert should happen
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('should upsert when no existing row', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null }); // getRow: no row

      const meta = { name: { source: 'booking' as const, confidence: 'high' as const, writtenAt: '2026-05-22T10:00:00.000Z' } };
      await store.upsertProfileWithMeta('corp1', 'user1', { name: '张三' }, meta);

      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          corp_id: 'corp1',
          user_id: 'user1',
          name: '张三',
          profile_fields_meta: meta,
        }),
        { onConflict: 'corp_id,user_id' },
      );
    });
  });

  describe('del (v1 compat)', () => {
    it('should delete from Redis cache', async () => {
      await store.del('profile:corp1:user1');

      expect(mockRedis.del).toHaveBeenCalledWith('profile:corp1:user1');
    });
  });
});

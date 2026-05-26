import { LongTermService } from '@memory/services/long-term.service';

describe('LongTermService', () => {
  const mockSupabaseStore = {
    getProfile: jest.fn(),
    upsertProfileWithMeta: jest.fn().mockResolvedValue(undefined),
    getSummaryData: jest.fn(),
    appendSummary: jest.fn().mockResolvedValue(undefined),
    markLastSettledMessageAt: jest.fn().mockResolvedValue(undefined),
  };

  let service: LongTermService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LongTermService(mockSupabaseStore as never);
  });

  describe('getProfile', () => {
    it('should return null when no profile exists', async () => {
      mockSupabaseStore.getProfile.mockResolvedValue(null);

      const profile = await service.getProfile('corp1', 'user1');

      expect(profile).toBeNull();
    });

    it('should return profile from store', async () => {
      mockSupabaseStore.getProfile.mockResolvedValue({
        name: '张三',
        phone: '13800138000',
        gender: '男',
        age: '22',
        is_student: true,
        education: '本科',
        has_health_certificate: '有',
      });

      const profile = await service.getProfile('corp1', 'user1');

      expect(profile?.name).toBe('张三');
      expect(profile?.is_student).toBe(true);
    });
  });

  describe('saveProfile', () => {
    it('should skip saving when all fields are null', async () => {
      await service.saveProfile('corp1', 'user1', { name: null, phone: null });

      expect(mockSupabaseStore.upsertProfileWithMeta).not.toHaveBeenCalled();
    });

    it('should save only non-null fields with enrichment medium meta', async () => {
      await service.saveProfile('corp1', 'user1', { name: '张三', phone: null, gender: '男' });

      expect(mockSupabaseStore.upsertProfileWithMeta).toHaveBeenCalledWith(
        'corp1',
        'user1',
        { name: '张三', gender: '男' },
        {
          name: expect.objectContaining({ source: 'enrichment', confidence: 'medium' }),
          gender: expect.objectContaining({ source: 'enrichment', confidence: 'medium' }),
        },
        undefined,
      );
    });
  });

  describe('writeFromBooking', () => {
    it('should call upsertProfileWithMeta with booking source and high confidence', async () => {
      await service.writeFromBooking('corp1', 'user1', {
        name: '张三',
        phone: '13800138000',
        age: 22,
        gender: '男',
      });

      expect(mockSupabaseStore.upsertProfileWithMeta).toHaveBeenCalledWith(
        'corp1',
        'user1',
        { name: '张三', phone: '13800138000', age: '22', gender: '男' },
        {
          name: expect.objectContaining({ source: 'booking', confidence: 'high' }),
          phone: expect.objectContaining({ source: 'booking', confidence: 'high' }),
          age: expect.objectContaining({ source: 'booking', confidence: 'high' }),
          gender: expect.objectContaining({ source: 'booking', confidence: 'high' }),
        },
      );
    });

    it('should convert age from number to string', async () => {
      await service.writeFromBooking('corp1', 'user1', {
        name: '李四',
        phone: '13900139000',
        age: 18,
        gender: '女',
      });

      const call = mockSupabaseStore.upsertProfileWithMeta.mock.calls[0];
      expect(call[2].age).toBe('18');
    });

    it('should include writtenAt ISO timestamp in each field meta', async () => {
      const before = new Date().toISOString();
      await service.writeFromBooking('corp1', 'user1', {
        name: '王五',
        phone: '13700137000',
        age: 30,
        gender: '男',
      });
      const after = new Date().toISOString();

      const meta = mockSupabaseStore.upsertProfileWithMeta.mock.calls[0][3];
      expect(meta.name.writtenAt >= before).toBe(true);
      expect(meta.name.writtenAt <= after).toBe(true);
    });

    it('should swallow errors from upsertProfileWithMeta silently', async () => {
      mockSupabaseStore.upsertProfileWithMeta.mockRejectedValueOnce(new Error('DB error'));

      await expect(
        service.writeFromBooking('corp1', 'user1', {
          name: '张三',
          phone: '13800138000',
          age: 22,
          gender: '男',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('getSummaryData', () => {
    it('should return null when no data', async () => {
      mockSupabaseStore.getSummaryData.mockResolvedValue(null);

      const result = await service.getSummaryData('corp1', 'user1');

      expect(result).toBeNull();
    });

    it('should return summary data', async () => {
      const data = {
        recent: [
          { summary: 'test', sessionId: 's1', startTime: '2026-03-15', endTime: '2026-03-15' },
        ],
        archive: 'old stuff',
        lastSettledMessageAt: '2026-03-15T10:00:00.000Z',
      };
      mockSupabaseStore.getSummaryData.mockResolvedValue(data);

      const result = await service.getSummaryData('corp1', 'user1');

      expect(result?.recent).toHaveLength(1);
      expect(result?.archive).toBe('old stuff');
      expect(result?.lastSettledMessageAt).toBe('2026-03-15T10:00:00.000Z');
    });
  });
});

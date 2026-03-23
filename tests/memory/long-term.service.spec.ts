import { LongTermService } from '@memory/long-term.service';

describe('LongTermService', () => {
  const mockSupabaseStore = {
    getProfile: jest.fn(),
    upsertProfile: jest.fn().mockResolvedValue(undefined),
    getSummaryData: jest.fn(),
    appendSummary: jest.fn().mockResolvedValue(undefined),
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

      expect(mockSupabaseStore.upsertProfile).not.toHaveBeenCalled();
    });

    it('should save only non-null fields', async () => {
      await service.saveProfile('corp1', 'user1', { name: '张三', phone: null, gender: '男' });

      expect(mockSupabaseStore.upsertProfile).toHaveBeenCalledWith(
        'corp1',
        'user1',
        { name: '张三', gender: '男' },
        undefined,
      );
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
        recent: [{ summary: 'test', sessionId: 's1', startTime: '2026-03-15', endTime: '2026-03-15' }],
        archive: 'old stuff',
      };
      mockSupabaseStore.getSummaryData.mockResolvedValue(data);

      const result = await service.getSummaryData('corp1', 'user1');

      expect(result?.recent).toHaveLength(1);
      expect(result?.archive).toBe('old stuff');
    });
  });

  describe('formatProfileForPrompt', () => {
    it('should return empty string for null profile', () => {
      expect(service.formatProfileForPrompt(null)).toBe('');
    });

    it('should format non-null profile fields', () => {
      const profile = {
        name: '张三',
        phone: '138',
        gender: null,
        age: '22',
        is_student: true,
        education: null,
        has_health_certificate: null,
      };

      const result = service.formatProfileForPrompt(profile);

      expect(result).toContain('[用户档案]');
      expect(result).toContain('姓名: 张三');
      expect(result).toContain('年龄: 22');
      expect(result).toContain('是否学生: 是');
    });
  });

  describe('formatSummaryForPrompt', () => {
    it('should return empty string for null data', () => {
      expect(service.formatSummaryForPrompt(null)).toBe('');
    });

    it('should format recent summaries', () => {
      const data = {
        recent: [
          { summary: '找上海兼职', sessionId: 's1', startTime: '2026-03-15T09:00:00Z', endTime: '2026-03-15T11:00:00Z' },
        ],
        archive: null,
      };

      const result = service.formatSummaryForPrompt(data);

      expect(result).toContain('[历史摘要]');
      expect(result).toContain('找上海兼职');
      expect(result).toContain('2026-03-15');
    });

    it('should include archive when present', () => {
      const data = {
        recent: [],
        archive: '曾多次咨询上海兼职',
      };

      const result = service.formatSummaryForPrompt(data);

      expect(result).toContain('历史总结');
      expect(result).toContain('曾多次咨询上海兼职');
    });
  });
});

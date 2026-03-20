import { LongTermService } from '@memory/long-term.service';

describe('LongTermService', () => {
  const mockSupabaseStore = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
  };

  let service: LongTermService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LongTermService(mockSupabaseStore as never);
  });

  describe('getProfile', () => {
    it('should return null when no profile exists', async () => {
      mockSupabaseStore.get.mockResolvedValue(null);

      const profile = await service.getProfile('corp1', 'user1');

      expect(profile).toBeNull();
      expect(mockSupabaseStore.get).toHaveBeenCalledWith('profile:corp1:user1:identity');
    });

    it('should return profile from stored content', async () => {
      mockSupabaseStore.get.mockResolvedValue({
        content: {
          name: '张三',
          phone: '13800138000',
          gender: '男',
          age: '22',
          is_student: true,
          education: '本科',
          has_health_certificate: '有',
        },
      });

      const profile = await service.getProfile('corp1', 'user1');

      expect(profile).toEqual({
        name: '张三',
        phone: '13800138000',
        gender: '男',
        age: '22',
        is_student: true,
        education: '本科',
        has_health_certificate: '有',
      });
    });
  });

  describe('saveProfile', () => {
    it('should skip saving when all fields are null', async () => {
      await service.saveProfile('corp1', 'user1', {
        name: null,
        phone: null,
      });

      expect(mockSupabaseStore.set).not.toHaveBeenCalled();
    });

    it('should save only non-null fields', async () => {
      await service.saveProfile('corp1', 'user1', {
        name: '张三',
        phone: null,
        gender: '男',
      });

      expect(mockSupabaseStore.set).toHaveBeenCalledWith(
        'profile:corp1:user1:identity',
        { name: '张三', gender: '男' },
      );
    });
  });

  describe('formatProfileForPrompt', () => {
    it('should return empty string for null profile', () => {
      expect(service.formatProfileForPrompt(null)).toBe('');
    });

    it('should return empty string for profile with all null fields', () => {
      const profile = {
        name: null,
        phone: null,
        gender: null,
        age: null,
        is_student: null,
        education: null,
        has_health_certificate: null,
      };

      expect(service.formatProfileForPrompt(profile)).toBe('');
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
      expect(result).toContain('联系方式: 138');
      expect(result).toContain('年龄: 22');
      expect(result).toContain('是否学生: 是');
    });
  });
});

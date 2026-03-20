import { MemoryService } from '@memory/memory.service';
import type { WeworkSessionState, EntityExtractionResult } from '@memory/memory.types';
// sessionTtl from mock config = 86400 (1d)
const SESSION_TTL = 86400;

describe('MemoryService', () => {
  const mockRedisStore = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn(),
  };

  const mockSupabaseStore = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn(),
  };

  let service: MemoryService;

  beforeEach(() => {
    jest.clearAllMocks();
    const mockConfig = { sessionTtl: 86400 };
    const mockShortTerm = {};
    const mockSessionFacts = { getSessionState: jest.fn(), getFacts: jest.fn() };
    const mockProcedural = { get: jest.fn() };
    const mockLongTerm = { getProfile: jest.fn() };
    service = new MemoryService(
      mockRedisStore as never,
      mockSupabaseStore as never,
      mockConfig as never,
      mockShortTerm as never,
      mockSessionFacts as never,
      mockProcedural as never,
      mockLongTerm as never,
    );
  });

  // ==================== 路由测试 ====================

  describe('store (routing)', () => {
    it('should route stage: keys to RedisStore without merge', async () => {
      await service.store('stage:corp1:user1', { currentStage: 'greeting' });
      expect(mockRedisStore.set).toHaveBeenCalledWith(
        'stage:corp1:user1',
        { currentStage: 'greeting' },
        SESSION_TTL,
        false,
      );
    });

    it('should route wework_session: keys to RedisStore with merge', async () => {
      await service.store('wework_session:corp1:user1', { name: '张三' });
      expect(mockRedisStore.set).toHaveBeenCalledWith(
        'wework_session:corp1:user1',
        { name: '张三' },
        SESSION_TTL,
        true,
      );
    });

    it('should route profile: keys to SupabaseStore', async () => {
      await service.store('profile:corp1:user1:pref', { style: 'formal' });
      expect(mockSupabaseStore.set).toHaveBeenCalledWith('profile:corp1:user1:pref', {
        style: 'formal',
      });
    });

    it('should default unknown prefix to stage (Redis, no merge)', async () => {
      await service.store('unknown:key', { data: true });
      expect(mockRedisStore.set).toHaveBeenCalledWith(
        'unknown:key',
        { data: true },
        SESSION_TTL,
        false,
      );
    });
  });

  describe('recall (routing)', () => {
    it('should route profile: to SupabaseStore', async () => {
      mockSupabaseStore.get.mockResolvedValue({ key: 'x', content: {}, updatedAt: '' });
      await service.recall('profile:corp1:user1:pref');
      expect(mockSupabaseStore.get).toHaveBeenCalledWith('profile:corp1:user1:pref');
    });

    it('should route other keys to RedisStore', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      await service.recall('stage:corp1:user1');
      expect(mockRedisStore.get).toHaveBeenCalledWith('stage:corp1:user1');
    });
  });

  describe('forget (routing)', () => {
    it('should route profile: to SupabaseStore', async () => {
      mockSupabaseStore.del.mockResolvedValue(true);
      await service.forget('profile:corp1:user1:pref');
      expect(mockSupabaseStore.del).toHaveBeenCalledWith('profile:corp1:user1:pref');
    });

    it('should route other keys to RedisStore', async () => {
      mockRedisStore.del.mockResolvedValue(true);
      await service.forget('stage:corp1:user1');
      expect(mockRedisStore.del).toHaveBeenCalledWith('stage:corp1:user1');
    });
  });

  // ==================== 结构化 Facts 访问 ====================

  describe('getSessionState', () => {
    it('should return empty state when no entry', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      const state = await service.getSessionState('corp1', 'user1', 'sess1');
      expect(state).toEqual({ facts: null, lastRecommendedJobs: null });
    });

    it('should return stored session state', async () => {
      const sessionState: WeworkSessionState = {
        facts: {
          interview_info: {
            name: '张三',
            phone: null,
            gender: null,
            age: null,
            applied_store: null,
            applied_position: null,
            interview_time: null,
            is_student: null,
            education: null,
            has_health_certificate: null,
          },
          preferences: {
            brands: null,
            salary: null,
            position: null,
            schedule: null,
            city: null,
            district: null,
            location: null,
            labor_form: null,
          },
          reasoning: '用户自我介绍',
        },
        lastRecommendedJobs: null,
      };
      mockRedisStore.get.mockResolvedValue({
        key: 'wework_session:corp1:user1:sess1',
        content: sessionState,
        updatedAt: '2026-03-18',
      });

      const state = await service.getSessionState('corp1', 'user1', 'sess1');
      expect(state.facts?.interview_info.name).toBe('张三');
    });
  });

  describe('saveFacts', () => {
    it('should merge with existing facts', async () => {
      const existingState: WeworkSessionState = {
        facts: {
          interview_info: {
            name: '张三',
            phone: null,
            gender: null,
            age: null,
            applied_store: null,
            applied_position: null,
            interview_time: null,
            is_student: null,
            education: null,
            has_health_certificate: null,
          },
          preferences: {
            brands: null,
            salary: null,
            position: null,
            schedule: null,
            city: '上海',
            district: null,
            location: null,
            labor_form: null,
          },
          reasoning: '第一轮',
        },
        lastRecommendedJobs: null,
      };
      mockRedisStore.get.mockResolvedValue({
        key: 'wework_session:corp1:user1:sess1',
        content: existingState,
        updatedAt: '2026-03-17',
      });

      const newFacts: EntityExtractionResult = {
        interview_info: {
          name: null,
          phone: '13800138000',
          gender: null,
          age: null,
          applied_store: null,
          applied_position: null,
          interview_time: null,
          is_student: null,
          education: null,
          has_health_certificate: null,
        },
        preferences: {
          brands: ['海底捞'],
          salary: null,
          position: null,
          schedule: null,
          city: null,
          district: null,
          location: null,
          labor_form: null,
        },
        reasoning: '第二轮',
      };

      await service.saveFacts('corp1', 'user1', 'sess1', newFacts);

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        'wework_session:corp1:user1:sess1',
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({
              name: '张三', // preserved from existing
              phone: '13800138000', // new value
            }),
            preferences: expect.objectContaining({
              city: '上海', // preserved
              brands: ['海底捞'], // new value
            }),
          }),
        }),
        SESSION_TTL,
        false,
      );
    });
  });

  // ==================== Prompt 格式化 ====================

  describe('formatSessionMemoryForPrompt', () => {
    it('should return empty string for empty state', () => {
      const result = service.formatSessionMemoryForPrompt({
        facts: null,
        lastRecommendedJobs: null,
      });
      expect(result).toBe('');
    });

    it('should format facts into structured prompt', () => {
      const state: WeworkSessionState = {
        facts: {
          interview_info: {
            name: '张三',
            phone: '13800138000',
            gender: '男',
            age: null,
            applied_store: null,
            applied_position: null,
            interview_time: null,
            is_student: true,
            education: null,
            has_health_certificate: null,
          },
          preferences: {
            brands: ['海底捞', '肯德基'],
            salary: null,
            position: null,
            schedule: null,
            city: '上海',
            district: null,
            location: null,
            labor_form: '兼职',
          },
          reasoning: 'test',
        },
        lastRecommendedJobs: null,
      };

      const result = service.formatSessionMemoryForPrompt(state);
      expect(result).toContain('候选人已知信息');
      expect(result).toContain('姓名: 张三');
      expect(result).toContain('联系方式: 13800138000');
      expect(result).toContain('是否学生: 是');
      expect(result).toContain('意向品牌: 海底捞、肯德基');
      expect(result).toContain('用工形式: 兼职');
      expect(result).toContain('意向城市: 上海');
    });

    it('should format recommended jobs', () => {
      const state: WeworkSessionState = {
        facts: null,
        lastRecommendedJobs: [
          {
            jobId: 1001,
            brandName: '海底捞',
            jobName: '服务员',
            storeName: '人民广场店',
            cityName: '上海',
            regionName: '黄浦区',
            laborForm: '全职',
            salaryDesc: '4000-6000 元/月',
            jobCategoryName: '餐饮',
          },
        ],
      };

      const result = service.formatSessionMemoryForPrompt(state);
      expect(result).toContain('上轮已推荐岗位');
      expect(result).toContain('jobId:1001');
      expect(result).toContain('海底捞');
      expect(result).toContain('服务员');
      expect(result).toContain('人民广场店');
    });
  });
});

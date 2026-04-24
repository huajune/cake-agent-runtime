import { SessionService } from '@memory/services/session.service';
import { ModelRole } from '@/llm/llm.types';
import type { EntityExtractionResult } from '@memory/types/session-facts.types';
import { FALLBACK_EXTRACTION } from '@memory/types/session-facts.types';

function mockStructured(obj: unknown) {
  return {
    output: obj,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  } as never;
}

describe('SessionService', () => {
  const mockRedisStore = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const mockConfig = { sessionTtl: 86400, sessionExtractionIncrementalMessages: 10 };

  const mockLlm = {
    generateStructured: jest.fn(),
  };

  const mockSponge = {
    fetchBrandList: jest.fn().mockResolvedValue([
      { name: '海底捞', aliases: ['HDL'] },
      { name: '肯德基', aliases: ['KFC', 'Kentucky'] },
      { name: '来伊份', aliases: ['来一份', '来1份'] },
    ]),
  };

  let service: SessionService;

  const changbaiJob = {
    jobId: 519709,
    brandName: '奥乐齐',
    jobName: '分拣打包',
    storeName: '长白',
    cityName: '上海',
    regionName: '杨浦',
    laborForm: '全职',
    salaryDesc: '6200-9800 元/月',
    jobCategoryName: '分拣员',
    distanceKm: 2.1,
  };

  const kongjiangJob = {
    jobId: 519710,
    brandName: '奥乐齐',
    jobName: '分拣打包',
    storeName: '控江',
    cityName: '上海',
    regionName: '杨浦',
    laborForm: '全职',
    salaryDesc: '6200-9800 元/月',
    jobCategoryName: '分拣员',
    distanceKm: 1.5,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SessionService(
      mockRedisStore as never,
      mockConfig as never,
      mockLlm as never,
      mockSponge as never,
    );
  });

  describe('store methods', () => {
    it('should return empty state when no data in Redis', async () => {
      mockRedisStore.get.mockResolvedValue(null);

      const state = await service.getSessionState('corp1', 'user1', 'session1');

      expect(state.facts).toBeNull();
      expect(state.lastCandidatePool).toBeNull();
      expect(state.presentedJobs).toBeNull();
      expect(state.currentFocusJob).toBeNull();
    });

    it('should return stored session state', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: FALLBACK_EXTRACTION,
          lastCandidatePool: [],
          presentedJobs: [],
          currentFocusJob: null,
          lastSessionActiveAt: '2026-03-20T00:00:00Z',
        },
      });

      const state = await service.getSessionState('corp1', 'user1', 'session1');

      expect(state.facts).toEqual(FALLBACK_EXTRACTION);
      expect(state.lastSessionActiveAt).toBe('2026-03-20T00:00:00Z');
    });

    it('should ignore invalid persisted session state from Redis', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: 'not-an-object',
          presentedJobs: [{ jobId: 'bad-id' }],
        },
      });

      const state = await service.getSessionState('corp1', 'user1', 'session1');

      expect(state).toEqual({
        facts: null,
        lastCandidatePool: null,
        presentedJobs: null,
        currentFocusJob: null,
        invitedGroups: null,
      });
    });

    it('should deepMerge with existing facts', async () => {
      const existing: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '张三' },
      };
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: existing,
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
        },
      });

      const newFacts: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, phone: '13800138000' },
      };

      await service.saveFacts('corp1', 'user1', 'session1', newFacts);

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.stringContaining('corp1:user1:session1'),
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({
              name: '张三',
              phone: '13800138000',
            }),
          }),
        }),
        86400,
        false,
      );
    });

    it('should overwrite merged interview_info field when forceNullFields is passed', async () => {
      // 回归 badcase batch_69e9bba2536c9654026522da_*：deepMerge 的 null 不覆盖语义
      // 会让污染的昵称卡在 Redis 里，sanitizer 需要通过 forceNullFields 显式清除。
      const existing: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        interview_info: {
          ...FALLBACK_EXTRACTION.interview_info,
          name: '阳光明媚',
          phone: '13800138000',
        },
      };
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: existing,
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
        },
      });

      const newFacts: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: null },
      };

      await service.saveFacts('corp1', 'user1', 'session1', newFacts, {
        forceNullFields: ['name'],
      });

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.stringContaining('corp1:user1:session1'),
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({
              name: null,
              phone: '13800138000', // 未列入 forceNullFields 的字段按常规 deepMerge 保留
            }),
          }),
        }),
        86400,
        false,
      );
    });

    it('should return null when no activity timestamp exists', async () => {
      mockRedisStore.get.mockResolvedValue(null);

      const result = await service.getLastSessionActiveAt('corp1', 'user1', 'session1');

      expect(result).toBeNull();
    });

    it('should return lastSessionActiveAt from state', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: { lastSessionActiveAt: '2026-03-20T10:00:00Z' },
      });

      const result = await service.getLastSessionActiveAt('corp1', 'user1', 'session1');

      expect(result).toBe('2026-03-20T10:00:00Z');
    });
  });

  describe('projection methods', () => {
    it('should save presented jobs inferred from assistant reply', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: null,
          lastCandidatePool: [changbaiJob],
          presentedJobs: null,
          currentFocusJob: null,
        },
      });

      await service.projectAssistantTurn({
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'sess-1',
        userText: '我想看看奥乐齐',
        assistantText: '杨浦奥乐齐这边有长白这家店，做分拣打包全职。',
      });

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          presentedJobs: [expect.objectContaining({ jobId: 519709, storeName: '长白' })],
        }),
        86400,
        false,
      );
    });

    it('should save current focus job when user explicitly selects a store', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: null,
          lastCandidatePool: [changbaiJob],
          presentedJobs: [changbaiJob],
          currentFocusJob: null,
        },
      });

      await service.projectAssistantTurn({
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'sess-1',
        userText: '我想报名长白',
        assistantText: '可以，我先帮你确认下长白这边的面试要求。',
      });

      expect(mockRedisStore.set).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          currentFocusJob: expect.objectContaining({ jobId: 519709, storeName: '长白' }),
        }),
        86400,
        false,
      );
    });

    it('should clear focus job when user asks to switch to another batch', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: null,
          lastCandidatePool: [changbaiJob],
          presentedJobs: [changbaiJob],
          currentFocusJob: changbaiJob,
        },
      });

      await service.projectAssistantTurn({
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'sess-1',
        userText: '再看看别的',
        assistantText: '行，我再给你看看别的岗位。',
      });

      expect(mockRedisStore.set).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          currentFocusJob: null,
        }),
        86400,
        false,
      );
    });

    it('should not lock focus job when multiple jobs match the same user phrase', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: null,
          lastCandidatePool: [changbaiJob, kongjiangJob],
          presentedJobs: [changbaiJob, kongjiangJob],
          currentFocusJob: null,
        },
      });

      await service.projectAssistantTurn({
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'sess-1',
        userText: '我想报名分拣打包',
        assistantText: '长白和控江都有分拣打包全职。',
      });

      const lockedFocusWrites = mockRedisStore.set.mock.calls.filter(([, payload]) => {
        if (!payload || typeof payload !== 'object' || !('currentFocusJob' in payload)) {
          return false;
        }
        return (payload as { currentFocusJob?: unknown }).currentFocusJob != null;
      });
      expect(lockedFocusWrites).toHaveLength(0);
    });
  });

  describe('extraction methods', () => {
    it('should skip extraction on empty messages', async () => {
      await service.extractAndSave('corp1', 'user1', 'sess1', []);
      expect(mockLlm.generateStructured).not.toHaveBeenCalled();
    });

    it('should use full conversation history on cache miss', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured({
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
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '第一轮问候' },
        { role: 'assistant', content: '第一轮回复' },
        { role: 'user', content: '第二轮补充，我叫张三' },
        { role: 'assistant', content: '第二轮确认' },
      ]);

      expect(mockLlm.generateStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          role: ModelRole.Extract,
          outputName: 'WeworkCandidateFacts',
          system: expect.any(String),
          prompt: expect.stringContaining('用户: 第一轮问候'),
        }),
      );
      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({ name: '张三' }),
          }),
        }),
        86400,
        false,
      );
    });

    it('should use INCREMENTAL_MESSAGES window on cache hit', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: {
            ...FALLBACK_EXTRACTION,
            interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '张三' },
            reasoning: 'prev',
          },
        },
      });
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured({
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
            brands: null,
            salary: null,
            position: null,
            schedule: null,
            city: null,
            district: null,
            location: null,
            labor_form: null,
          },
          reasoning: '用户提供电话',
        }),
      );

      const messages = Array.from({ length: 12 }, (_, index) => ({
        role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `历史消息${index + 1}`,
      }));
      messages.push({ role: 'user', content: '我的电话是13800138000' });

      await service.extractAndSave('corp1', 'user1', 'sess1', messages);

      const llmPrompt = mockLlm.generateStructured.mock.calls[0]?.[0]?.prompt as string;
      expect(llmPrompt).toContain('用户: 历史消息3');
      expect(llmPrompt).not.toContain('用户: 历史消息1\n');
      expect(mockRedisStore.set).toHaveBeenCalled();
    });

    it('should use fallback on LLM failure', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockRejectedValue(new Error('LLM timeout'));

      await service.extractAndSave('corp1', 'user1', 'sess1', [{ role: 'user', content: '你好' }]);

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            reasoning: '实体提取失败，使用空值降级',
          }),
        }),
        86400,
        false,
      );
    });

    it('should use fallback when output is null', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockRejectedValue(new Error('No structured output returned'));

      await service.extractAndSave('corp1', 'user1', 'sess1', [{ role: 'user', content: '你好' }]);

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            reasoning: '实体提取失败，使用空值降级',
          }),
        }),
        86400,
        false,
      );
    });

    it('should validate persisted candidate pool shape before saving', async () => {
      mockRedisStore.get.mockResolvedValue(null);

      await expect(
        service.saveLastCandidatePool('corp1', 'user1', 'sess1', [
          { jobId: 'bad-id' } as unknown as any,
        ]),
      ).rejects.toThrow();
    });

    it('should filter out system messages', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured({
          interview_info: {
            name: null,
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
          reasoning: '无有效信息',
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: '你好' },
      ]);

      const callArgs = mockLlm.generateStructured.mock.calls[0][0];
      expect(callArgs.prompt).not.toContain('You are a helpful assistant');
    });

    it('should include brand data in prompt', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured({
          interview_info: {
            name: null,
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
          reasoning: '无',
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [{ role: 'user', content: '你好' }]);

      const callArgs = mockLlm.generateStructured.mock.calls[0][0];
      expect(callArgs.prompt).toContain('海底捞');
      expect(callArgs.prompt).toContain('肯德基');
      expect(callArgs.prompt).toContain('KFC');
    });

    it('should normalize brand aliases into standard brand names before saving facts', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured({
          interview_info: {
            name: null,
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
          reasoning: '无',
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '来一份' },
      ]);

      const callArgs = mockLlm.generateStructured.mock.calls[0][0];
      expect(callArgs.prompt).toContain('[品牌别名命中提示]');
      expect(callArgs.prompt).toContain('来一份');
      expect(callArgs.prompt).toContain('来伊份');
      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            preferences: expect.objectContaining({
              brands: ['来伊份'],
            }),
            reasoning: expect.stringContaining('来伊份'),
          }),
        }),
        86400,
        false,
      );
    });

    it('should not misclassify generic phrases that merely contain alias text', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured({
          interview_info: {
            name: null,
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
          reasoning: '无',
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '给我来一份工作' },
      ]);

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            preferences: expect.objectContaining({
              brands: null,
            }),
          }),
        }),
        86400,
        false,
      );
    });
  });
});

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

function factValue<T>(value: T, extra: Record<string, unknown> = {}) {
  return expect.objectContaining({ value, ...extra });
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
          facts: {
            ...FALLBACK_EXTRACTION,
            interview_info: { ...FALLBACK_EXTRACTION.interview_info, age: '24' },
          },
          lastCandidatePool: [],
          presentedJobs: [],
          currentFocusJob: null,
        },
      });

      const state = await service.getSessionState('corp1', 'user1', 'session1');

      expect(state.facts?.interview_info.age).toEqual(
        factValue('24', { confidence: 'unknown', source: 'memory' }),
      );
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

    it('should silently strip unknown lastSessionActiveAt field from old Redis data (backward compat)', async () => {
      // Old Redis entries (written before the refactor) may contain `lastSessionActiveAt`.
      // Zod's z.object() strips unknown keys by default — this must NOT cause a parse error.
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: FALLBACK_EXTRACTION,
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
          invitedGroups: null,
          lastSessionActiveAt: '2026-04-01T10:00:00.000Z', // legacy field
        },
      });

      const state = await service.getSessionState('corp1', 'user1', 'session1');

      // Should parse successfully — legacy field stripped, known fields intact
      expect(state.facts).toEqual(FALLBACK_EXTRACTION);
      expect(state).not.toHaveProperty('lastSessionActiveAt');
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
              name: factValue('张三', { confidence: 'unknown', source: 'memory' }),
              phone: factValue('13800138000', { confidence: 'unknown', source: 'memory' }),
            }),
          }),
        }),
        86400,
        false,
      );
    });

    it('should persist optional interview fields used by booking precheck', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: null,
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
        },
      });

      const newFacts: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        interview_info: {
          ...FALLBACK_EXTRACTION.interview_info,
          height: '170',
          weight: '60',
          household_register_province: '安徽',
        },
      };

      await service.saveFacts('corp1', 'user1', 'session1', newFacts);

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.stringContaining('corp1:user1:session1'),
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({
              height: factValue('170', { confidence: 'unknown', source: 'memory' }),
              weight: factValue('60', { confidence: 'unknown', source: 'memory' }),
              household_register_province: factValue('安徽', {
                confidence: 'unknown',
                source: 'memory',
              }),
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
              phone: factValue('13800138000', {
                confidence: 'unknown',
                source: 'memory',
              }), // 未列入 forceNullFields 的字段按常规 deepMerge 保留
            }),
          }),
        }),
        86400,
        false,
      );
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
            interview_info: expect.objectContaining({
              name: factValue('张三', { confidence: 'medium', source: 'llm' }),
            }),
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

    it('should still save high-confidence rule facts when LLM extraction fails', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockRejectedValue(new Error('LLM timeout'));

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '我的电话是13800138000' },
      ]);

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({
              phone: factValue('13800138000', { confidence: 'high', source: 'rule' }),
            }),
            reasoning: expect.stringContaining('规则模式匹配参考线索'),
          }),
        }),
        86400,
        false,
      );
    });

    it('should let LLM output take precedence over conflicting rule facts', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured({
          ...FALLBACK_EXTRACTION,
          interview_info: {
            ...FALLBACK_EXTRACTION.interview_info,
            is_student: true,
            education: '本科',
          },
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
            city: '上海',
          },
          reasoning: 'LLM 提取到本科和上海',
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '我是大三本科在读，我在苏州市，只周末上班' },
      ]);

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({
              // LLM 的 "本科" 优先于规则的 "本科在读"
              education: factValue('本科', { confidence: 'medium', source: 'llm' }),
            }),
            preferences: expect.objectContaining({
              // LLM 的 "上海" 优先于规则的 "苏州"
              city: factValue('上海', { confidence: 'high' }),
              // 规则兜底：LLM 未提取 schedule_constraint，规则补位
              schedule_constraint: factValue(
                expect.objectContaining({
                  onlyWeekends: true,
                }),
                { confidence: 'high', source: 'rule' },
              ),
            }),
            reasoning: expect.stringContaining('规则模式匹配参考线索'),
          }),
        }),
        86400,
        false,
      );
    });

    it('should backfill rule facts when LLM returns null for a field', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured({
          ...FALLBACK_EXTRACTION,
          interview_info: {
            ...FALLBACK_EXTRACTION.interview_info,
            name: '张三',
          },
          preferences: {
            ...FALLBACK_EXTRACTION.preferences,
          },
          reasoning: 'LLM 只提取到姓名',
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '我叫张三，电话13800138000' },
      ]);

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({
              name: factValue('张三', { confidence: 'medium', source: 'llm' }),
              phone: factValue('13800138000', { confidence: 'high', source: 'rule' }),
            }),
          }),
        }),
        86400,
        false,
      );
    });

    it('should recover rule-extracted structured name after LLM nickname is sanitized', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      // LLM 从"我是阳光明媚"提取了昵称，sanitizer 会 drop 它
      // 规则从"姓名：赵堤"提取了结构化真名，应该在 sanitize 后补位
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured({
          ...FALLBACK_EXTRACTION,
          interview_info: {
            ...FALLBACK_EXTRACTION.interview_info,
            name: '阳光明媚',
          },
          reasoning: 'LLM 提取到"阳光明媚"',
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '我是阳光明媚' },
        { role: 'assistant', content: '你好' },
        { role: 'user', content: '姓名：赵堤' },
      ]);

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({
              name: factValue('赵堤', { confidence: 'high', source: 'rule' }),
            }),
          }),
        }),
        86400,
        false,
      );
    });

    it('should backfill city from whitelist district when LLM leaves city null', async () => {
      // LLM 按 session-extraction prompt 对单独区名留 null city（防跨城同名）。
      // 但 DISTRICT_TO_CITY 白名单已经把跨城同名排除，应当用确定性兜底补 city。
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
            district: ['青浦'],
            location: null,
            labor_form: null,
          },
          reasoning: '用户提到青浦区',
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '你好我在青浦区' },
      ]);

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            preferences: expect.objectContaining({
              city: factValue('上海', {
                confidence: 'high',
                source: 'rule',
                evidence: 'unique_district_alias',
              }),
              district: factValue(['青浦'], { confidence: 'high', source: 'rule' }),
            }),
          }),
        }),
        86400,
        false,
      );
    });
    it('should not overwrite city when LLM already filled it', async () => {
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
            city: '北京',
            district: ['青浦'],
            location: null,
            labor_form: null,
          },
          reasoning: '历史明示了北京（虽然本轮 district 误识为青浦）',
        }),
      );

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '北京但有亲戚在青浦' },
      ]);

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            preferences: expect.objectContaining({
              city: expect.objectContaining({ value: '北京' }),
            }),
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
              brands: factValue(['来伊份'], { confidence: 'high', source: 'rule' }),
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

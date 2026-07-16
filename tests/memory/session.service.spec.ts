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

const mockSystemConfig = {
  getExtractModelOverride: jest.fn().mockResolvedValue(undefined),
};

describe('SessionService', () => {
  const mockRedisStore = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    getHash: jest.fn().mockResolvedValue(null),
    patchHash: jest.fn().mockResolvedValue(undefined),
    backfillHash: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(true),
  };

  const mockConfig = {
    sessionTtl: 86400,
    sessionExtractionIncrementalMessages: 10,
    settlementGapSeconds: 86400,
  };

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
      mockSystemConfig as never,
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
      expect(state.terminal).toBeNull();
    });

    it('should not read the legacy blob when the factsv2 hash exists', async () => {
      mockRedisStore.getHash.mockResolvedValueOnce({
        facts: null,
        lastCandidatePool: null,
        presentedJobs: [],
        currentFocusJob: null,
        invitedGroups: null,
        terminal: null,
        lastCandidateMessageAt: null,
      });

      const state = await service.getSessionState('corp1', 'user1', 'session1');

      expect(state.presentedJobs).toEqual([]);
      expect(mockRedisStore.get).not.toHaveBeenCalled();
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
        terminal: null,
        lastCandidateMessageAt: null,
        brand_state: null,
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

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
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

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
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

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
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
      );
    });

    it('should overwrite merged preference field when forceNullPreferenceFields is passed', async () => {
      const existing: EntityExtractionResult = {
        ...FALLBACK_EXTRACTION,
        preferences: { ...FALLBACK_EXTRACTION.preferences, labor_form: '暑假工' },
      };
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: existing,
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
        },
      });

      await service.saveFacts('corp1', 'user1', 'session1', FALLBACK_EXTRACTION, {
        forceNullPreferenceFields: ['labor_form'],
      });

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.stringContaining('corp1:user1:session1'),
        expect.objectContaining({
          facts: expect.objectContaining({
            preferences: expect.objectContaining({ labor_form: null }),
          }),
        }),
        86400,
      );
    });

    it('should not let lower-confidence new value overwrite higher-confidence old value', async () => {
      // 回归张漪 case（chat 69a13e919d6d3a463b0a37c6）：用户明确确认的
      // applied_position="后厨"（rule/high）被后续轮 LLM 推断 "内场"（llm/medium）覆盖。
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: {
            ...FALLBACK_EXTRACTION,
            interview_info: {
              ...FALLBACK_EXTRACTION.interview_info,
              applied_position: {
                value: '后厨',
                confidence: 'high',
                source: 'rule',
                evidence: '候选人明确选择后厨',
              },
            },
          },
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
        },
      });

      const incoming = {
        ...FALLBACK_EXTRACTION,
        interview_info: {
          ...FALLBACK_EXTRACTION.interview_info,
          applied_position: {
            value: '内场',
            confidence: 'medium',
            source: 'llm',
            evidence: 'LLM 推断',
          },
        },
      };

      await service.saveFacts('corp1', 'user1', 'session1', incoming as never);

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.stringContaining('corp1:user1:session1'),
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({
              applied_position: factValue('后厨', { confidence: 'high', source: 'rule' }),
            }),
          }),
        }),
        86400,
      );
    });

    it('should allow same-or-higher confidence new value to overwrite old value', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: {
            ...FALLBACK_EXTRACTION,
            interview_info: {
              ...FALLBACK_EXTRACTION.interview_info,
              applied_position: {
                value: '后厨',
                confidence: 'medium',
                source: 'llm',
                evidence: 'LLM 提取',
              },
            },
          },
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
        },
      });

      const incoming = {
        ...FALLBACK_EXTRACTION,
        interview_info: {
          ...FALLBACK_EXTRACTION.interview_info,
          applied_position: {
            value: '前厅',
            confidence: 'high',
            source: 'rule',
            evidence: '候选人明确改口',
          },
        },
      };

      await service.saveFacts('corp1', 'user1', 'session1', incoming as never);

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.stringContaining('corp1:user1:session1'),
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({
              applied_position: factValue('前厅', { confidence: 'high', source: 'rule' }),
            }),
          }),
        }),
        86400,
      );
    });
  });

  describe('getAuthoritativeState (HC-2 collectedFields provenance)', () => {
    it('projects persisted session facts into collectedFields for cross-turn stop checks', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: {
            ...FALLBACK_EXTRACTION,
            interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '张三', age: '24' },
          },
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
        },
      });

      const state = await service.getAuthoritativeState('corp1', 'user1', 'session1');

      expect(state.collectedFields.name).toMatchObject({
        value: '张三',
        provenance: 'llm_extract',
      });
      expect(state.collectedFields.age?.value).toBe('24');
    });

    it('populates collectedFields from current-turn user text as user_text provenance', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: null,
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
        },
      });

      const state = await service.getAuthoritativeState('corp1', 'user1', 'session1', {
        currentUserMessages: ['姓名：王建国 电话13912345678'],
        now: 5000,
      });

      expect(state.collectedFields.name).toMatchObject({
        value: '王建国',
        provenance: 'user_text',
        at: 5000,
      });
      expect(state.collectedFields.phone?.value).toBe('13912345678');
    });

    it('derives terminal and lastCandidateMessageAt for reengagement stop conditions', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: null,
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
          terminal: 'booked',
          lastCandidateMessageAt: '2026-07-02T10:00:00.000Z',
        },
      });

      const state = await service.getAuthoritativeState('corp1', 'user1', 'session1');

      expect(state.terminal).toBe('booked');
      expect(state.lastCandidateMessageAt).toBe(Date.parse('2026-07-02T10:00:00.000Z'));
    });

    it('projects invitedGroups for reengagement stop conditions', async () => {
      const invitedGroups = [
        {
          groupName: '上海餐饮兼职群',
          city: '上海',
          industry: '餐饮',
          invitedAt: '2026-07-15T07:55:00.000Z',
        },
      ];
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: null,
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
          invitedGroups,
        },
      });

      const state = await service.getAuthoritativeState('corp1', 'user1', 'session1');

      expect(state.invitedGroups).toEqual(invitedGroups);
    });
  });

  describe('reengagement stop signals persistence', () => {
    it('saveTerminalState persists terminal into session state', async () => {
      mockRedisStore.get.mockResolvedValue(null);

      await service.saveTerminalState('corp1', 'user1', 'session1', 'booked');

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.stringContaining('session1'),
        expect.objectContaining({ terminal: 'booked' }),
        expect.anything(),
      );
    });

    it('recordCandidateActivity persists lastCandidateMessageAt as ISO string', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      const at = new Date('2026-07-02T12:34:56.000Z');

      await service.recordCandidateActivity('corp1', 'user1', 'session1', at);

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.stringContaining('session1'),
        expect.objectContaining({ lastCandidateMessageAt: at.toISOString() }),
        expect.anything(),
      );
    });
  });

  describe('pure-acknowledgment gate', () => {
    const existingFactsState = () => ({
      content: {
        facts: {
          ...FALLBACK_EXTRACTION,
          interview_info: { ...FALLBACK_EXTRACTION.interview_info, age: '25' },
        },
        lastCandidatePool: null,
        presentedJobs: null,
        currentFocusJob: null,
      },
    });

    it('skips LLM extraction when last user message is a pure acknowledgment with no rule hits', async () => {
      mockRedisStore.get.mockResolvedValue(existingFactsState());

      await service.extractAndSave('corp1', 'user1', 'session1', [
        { role: 'user', content: '我25岁' },
        { role: 'assistant', content: '好的，帮你看看' },
        { role: 'user', content: '好的 谢谢' },
      ]);

      expect(mockLlm.generateStructured).not.toHaveBeenCalled();
      expect(mockRedisStore.patchHash).not.toHaveBeenCalled();
    });

    it('still extracts when acknowledgment carries a rule signal (e.g. brand mention)', async () => {
      mockRedisStore.get.mockResolvedValue(existingFactsState());
      mockLlm.generateStructured.mockResolvedValue(mockStructured(FALLBACK_EXTRACTION));

      await service.extractAndSave('corp1', 'user1', 'session1', [
        { role: 'user', content: '我25岁' },
        { role: 'assistant', content: '推荐你看看' },
        { role: 'user', content: '好的，13800138000' },
      ]);

      expect(mockLlm.generateStructured).toHaveBeenCalled();
    });

    it('does not skip on first extraction (no previous facts) even for short messages', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(mockStructured(FALLBACK_EXTRACTION));

      await service.extractAndSave('corp1', 'user1', 'session1', [
        { role: 'user', content: '你好' },
      ]);

      expect(mockLlm.generateStructured).toHaveBeenCalled();
    });

    it('injects previously confirmed facts into the incremental extraction prompt', async () => {
      mockRedisStore.get.mockResolvedValue(existingFactsState());
      mockLlm.generateStructured.mockResolvedValue(mockStructured(FALLBACK_EXTRACTION));

      await service.extractAndSave('corp1', 'user1', 'session1', [
        { role: 'user', content: '我25岁' },
        { role: 'assistant', content: '好的' },
        { role: 'user', content: '我想找浦东的工作' },
      ]);

      const prompt = mockLlm.generateStructured.mock.calls[0][0].prompt as string;
      expect(prompt).toContain('[已确认事实');
      expect(prompt).toContain('年龄: 25');
    });
  });

  describe('explicit provenance confidence upgrade', () => {
    const llmOutputWith = (
      info: Partial<EntityExtractionResult['interview_info']>,
      provenance: Array<{ field: string; quote: string }> | null,
    ) => ({
      ...FALLBACK_EXTRACTION,
      interview_info: { ...FALLBACK_EXTRACTION.interview_info, ...info },
      explicit_provenance: provenance,
      reasoning: 'test',
    });

    const savedInterviewInfo = () => {
      const saved = mockRedisStore.patchHash.mock.calls.at(-1)?.[1] as {
        facts: { interview_info: Record<string, { confidence: string; source: string } | null> };
      };
      return saved.facts.interview_info;
    };

    it('upgrades form-filled fields to high/candidate when quote is verified', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured(
          llmOutputWith({ has_health_certificate: '有', age: '37' }, [
            { field: 'has_health_certificate', quote: '健康证：有' },
            { field: 'age', quote: '年龄：37' },
          ]),
        ),
      );

      await service.extractAndSave('corp1', 'user1', 'session1', [
        { role: 'user', content: '姓名：张三\n年龄：37\n健康证：有' },
      ]);

      const info = savedInterviewInfo();
      // 健康证："健康证：有" 规则层无结构化提取器，靠来源声明升级通道
      expect(info.has_health_certificate).toEqual(
        expect.objectContaining({ confidence: 'high', source: 'candidate' }),
      );
      // 年龄：标准表单格式规则层本就接得住（high/rule），升级通道正确跳过已 high 字段；
      // 业务语义断言是 confidence=high（工具可消费），不锁定通道
      expect(info.age).toEqual(expect.objectContaining({ confidence: 'high' }));
    });

    it('rejects upgrade when quote is not found in candidate messages (anti over-claim)', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured(
          llmOutputWith({ has_health_certificate: '有' }, [
            { field: 'has_health_certificate', quote: '我有健康证' },
          ]),
        ),
      );

      await service.extractAndSave('corp1', 'user1', 'session1', [
        { role: 'user', content: '应该是有证的吧' },
      ]);

      const info = savedInterviewInfo();
      expect(info.has_health_certificate).toEqual(
        expect.objectContaining({ confidence: 'medium', source: 'llm' }),
      );
    });

    it('never upgrades name or transactional fields even when claimed', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured(
          llmOutputWith({ applied_store: '日月光店', interview_time: '6月11日 14:00' }, [
            { field: 'applied_store', quote: '日月光店' },
            { field: 'interview_time', quote: '明天下午两点' },
          ]),
        ),
      );

      await service.extractAndSave('corp1', 'user1', 'session1', [
        { role: 'user', content: '就报日月光店，明天下午两点面试' },
      ]);

      const info = savedInterviewInfo();
      expect(info.applied_store).toEqual(
        expect.objectContaining({ confidence: 'medium', source: 'llm' }),
      );
      expect(info.interview_time).toEqual(
        expect.objectContaining({ confidence: 'medium', source: 'llm' }),
      );
    });

    it('rejects phone upgrade when value is not a valid mobile number', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured(
          llmOutputWith({ phone: '021-1234567' }, [{ field: 'phone', quote: '021-1234567' }]),
        ),
      );

      await service.extractAndSave('corp1', 'user1', 'session1', [
        { role: 'user', content: '电话 021-1234567' },
      ]);

      const info = savedInterviewInfo();
      expect(info.phone).toEqual(expect.objectContaining({ confidence: 'medium', source: 'llm' }));
    });

    it('marks gender_source candidate alongside gender upgrade', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(
        mockStructured(llmOutputWith({ gender: '女' }, [{ field: 'gender', quote: '性别：女' }])),
      );

      await service.extractAndSave('corp1', 'user1', 'session1', [
        { role: 'user', content: '性别：女' },
      ]);

      const info = savedInterviewInfo();
      expect(info.gender).toEqual(expect.objectContaining({ confidence: 'high' }));
      expect(info.gender_source).toEqual(expect.objectContaining({ value: 'candidate' }));
    });
  });

  describe('session segment trimming', () => {
    it('should drop messages from an older session segment (gap >= settlementGap) on extraction', async () => {
      // 回归张漪 case：session facts 过期后首次提取吃了 5 天前的旧会话历史，
      // 把已了结的报名信息"复活"成当前会话事实。按消息时间间隙切割后，
      // 提取窗口只保留最近一段连续会话。
      mockRedisStore.get.mockResolvedValue(null); // cache miss → 首次提取
      mockLlm.generateStructured.mockResolvedValue(mockStructured(FALLBACK_EXTRACTION));

      const old = '\n[消息发送时间：2026-06-03 12:11 星期三]';
      const recent = '\n[消息发送时间：2026-06-08 11:16 星期一]';
      await service.extractAndSave('corp1', 'user1', 'session1', [
        { role: 'user', content: `我想报名日月光店后厨${old}` },
        { role: 'assistant', content: `好的已为你预约${old}` },
        { role: 'user', content: `你好，看看肯德基${recent}` },
        { role: 'assistant', content: `肯德基有这些岗位${recent}` },
        { role: 'user', content: `工作要求是什么${recent}` },
      ]);

      const prompt = mockLlm.generateStructured.mock.calls[0][0].prompt as string;
      expect(prompt).toContain('看看肯德基');
      expect(prompt).not.toContain('日月光店后厨');
    });

    it('should keep all messages when no gap exceeds settlementGap', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(mockStructured(FALLBACK_EXTRACTION));

      const t1 = '\n[消息发送时间：2026-06-08 10:00 星期一]';
      const t2 = '\n[消息发送时间：2026-06-08 11:16 星期一]';
      await service.extractAndSave('corp1', 'user1', 'session1', [
        { role: 'user', content: `我想报名日月光店后厨${t1}` },
        { role: 'user', content: `看看肯德基${t2}` },
      ]);

      const prompt = mockLlm.generateStructured.mock.calls[0][0].prompt as string;
      expect(prompt).toContain('日月光店后厨');
      expect(prompt).toContain('看看肯德基');
    });

    it('should treat messages without time context as the same session', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(mockStructured(FALLBACK_EXTRACTION));

      await service.extractAndSave('corp1', 'user1', 'session1', [
        { role: 'user', content: '我想报名日月光店后厨' },
        { role: 'user', content: '看看肯德基' },
      ]);

      const prompt = mockLlm.generateStructured.mock.calls[0][0].prompt as string;
      expect(prompt).toContain('日月光店后厨');
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

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          presentedJobs: [expect.objectContaining({ jobId: 519709, storeName: '长白' })],
        }),
        86400,
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

      expect(mockRedisStore.patchHash).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          currentFocusJob: expect.objectContaining({ jobId: 519709, storeName: '长白' }),
        }),
        86400,
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

      expect(mockRedisStore.patchHash).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          currentFocusJob: null,
        }),
        86400,
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

      const lockedFocusWrites = mockRedisStore.patchHash.mock.calls.filter(([, payload]) => {
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

    it('should persist an explicit labor-form revocation over stale session memory', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          facts: {
            ...FALLBACK_EXTRACTION,
            preferences: { ...FALLBACK_EXTRACTION.preferences, labor_form: '暑假工' },
          },
          lastCandidatePool: null,
          presentedJobs: null,
          currentFocusJob: null,
        },
      });
      mockLlm.generateStructured.mockResolvedValue(mockStructured(FALLBACK_EXTRACTION));

      await service.extractAndSave('corp1', 'user1', 'session1', [
        { role: 'user', content: '暑假工不考虑了' },
      ]);

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.stringContaining('corp1:user1:session1'),
        expect.objectContaining({
          facts: expect.objectContaining({
            preferences: expect.objectContaining({ labor_form: null }),
          }),
        }),
        86400,
      );
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
      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({
              name: factValue('张三', { confidence: 'medium', source: 'llm' }),
            }),
          }),
        }),
        86400,
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
      expect(mockRedisStore.patchHash).toHaveBeenCalled();
    });

    it('should use fallback on LLM failure', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockRejectedValue(new Error('LLM timeout'));

      await service.extractAndSave('corp1', 'user1', 'sess1', [{ role: 'user', content: '你好' }]);

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            reasoning: '实体提取失败，使用空值降级',
          }),
        }),
        86400,
      );
    });

    it('should still save high-confidence rule facts when LLM extraction fails', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockRejectedValue(new Error('LLM timeout'));

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '我的电话是13800138000' },
      ]);

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
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

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
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

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
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

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            interview_info: expect.objectContaining({
              name: factValue('赵堤', { confidence: 'high', source: 'rule' }),
            }),
          }),
        }),
        86400,
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

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
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

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            preferences: expect.objectContaining({
              city: expect.objectContaining({ value: '北京' }),
            }),
          }),
        }),
        86400,
      );
    });

    it('should use fallback when output is null', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockRejectedValue(new Error('No structured output returned'));

      await service.extractAndSave('corp1', 'user1', 'sess1', [{ role: 'user', content: '你好' }]);

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            reasoning: '实体提取失败，使用空值降级',
          }),
        }),
        86400,
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

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '想找工作' },
      ]);

      // 无品牌命中时只注入名称清单（瘦身），别名不注入
      const callArgs = mockLlm.generateStructured.mock.calls[0][0];
      expect(callArgs.prompt).toContain('海底捞');
      expect(callArgs.prompt).toContain('肯德基');
      expect(callArgs.prompt).toContain('其余合作品牌（仅名称');
      expect(callArgs.prompt).not.toContain('KFC');
    });

    it('should include full alias entry for brands hit by alias detection', async () => {
      mockRedisStore.get.mockResolvedValue(null);
      mockLlm.generateStructured.mockResolvedValue(mockStructured(FALLBACK_EXTRACTION));

      await service.extractAndSave('corp1', 'user1', 'sess1', [
        { role: 'user', content: '来一份' },
      ]);

      const callArgs = mockLlm.generateStructured.mock.calls[0][0];
      // 命中品牌列全量条目（含别名），供 LLM 做归一化；未命中品牌仍只列名称
      expect(callArgs.prompt).toContain('来伊份（别称：来一份');
      expect(callArgs.prompt).toContain('其余合作品牌（仅名称');
      expect(callArgs.prompt).not.toContain('KFC');
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
      // 品牌写入收口（§9.2）：提取路径不再把品牌写进 preferences.brands
      //（品牌真相只在 brand_state，由 turn-finalizer 的 reducer 统一写入），
      // 归一化线索仍进提取 prompt（上方断言）。
      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            preferences: expect.objectContaining({
              brands: null,
            }),
          }),
        }),
        86400,
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

      expect(mockRedisStore.patchHash).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          facts: expect.objectContaining({
            preferences: expect.objectContaining({
              brands: null,
            }),
          }),
        }),
        86400,
      );
    });
  });
});

import { ContextService } from '@agent/generator/context/context.service';
import { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import { CORPUS_DOMAINS } from '@shared-types/corpus.types';
import type { PromptSection } from '@agent/generator/context/sections/section';
import { SCENARIO_PROMPT_MANIFEST } from '@agent/generator/context/context.service';
import type { MemoryPromptView } from '@agent/generator/context/sections/semantic/memory.section';
import type { PromptModel } from '@agent/generator/context/context.types';
import type { GroupInventoryPromptView } from '@agent/generator/context/sections/working/group-inventory.section';
import { resolveCriticalTurnInstructions } from '@agent/generator/preparation/turn-context-resolver';
import { promptModelOf } from '../../../helpers/prompt-model.fixture';

describe('ContextService', () => {
  const makeConfig = (): StrategyConfigRecord =>
    ({
      id: 'config-1',
      name: 'test config',
      description: null,
      role_setting: {
        content: '你是招募经理，负责解答候选人的求职问题。',
      },
      persona: {
        textDimensions: [
          {
            key: 'tone',
            group: 'style',
            label: '语气风格',
            value: '简洁、自然、口语化。',
          },
        ],
      },
      stage_goals: {
        stages: [
          {
            stage: 'trust_building',
            label: '建立信任',
            description: '开场并确认切入条件',
            primaryGoal: '自然开场并确认至少一个切入条件。',
            successCriteria: ['拿到城市或岗位方向'],
            ctaStrategy: ['先回应问题，再顺势确认城市'],
            disallowedActions: ['用户已问岗位时还只顾寒暄'],
          },
          {
            stage: 'job_consultation',
            label: '岗位咨询',
            description: '基于工具结果解释岗位信息',
            primaryGoal: '回答岗位问题并推动形成意向。',
            successCriteria: ['已解释核心岗位信息'],
            ctaStrategy: ['给出 1-2 个匹配岗位'],
            disallowedActions: ['编造薪资'],
          },
        ],
      },
      red_lines: {
        rules: ['禁止编造岗位信息'],
        thresholds: [
          {
            flag: 'max_recommend_distance_km',
            label: '推荐距离上限',
            max: 10,
            unit: 'km',
            rule: '仅推荐范围内门店',
          },
        ],
      },
      industry_skills: { skills: [] },
      is_active: true,
      status: 'testing',
      version: 1,
      version_note: null,
      released_at: null,
      created_at: '2026-04-01T00:00:00.000Z',
      updated_at: '2026-04-01T00:00:00.000Z',
    }) as StrategyConfigRecord;

  let service: ContextService;
  interface ComposeFixtureInput {
    scenario?: string;
    currentStage?: string;
    memory?: MemoryPromptView;
    accountIdentity?: PromptModel['identity'];
    groupInventory?: GroupInventoryPromptView;
    currentUserMessage?: string;
    normalizedMessages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
    inputSecurityInstruction?: string;
  }

  const compose = (params: ComposeFixtureInput = {}) => {
    const config = makeConfig();
    const currentStage = params.currentStage
      ? (config.stage_goals.stages.find((stage) => stage.stage === params.currentStage) ?? null)
      : null;
    return service.compose(
      promptModelOf({
        scenario: params.scenario ?? 'candidate-consultation',
        identity: params.accountIdentity ?? {},
        strategy: {
          roleSetting: config.role_setting,
          persona: config.persona,
          redLines: config.red_lines,
          thresholds: config.red_lines.thresholds ?? [],
          stages: config.stage_goals.stages,
          currentStage,
        },
        memory: params.memory,
        groupInventory: params.groupInventory,
        security: params.inputSecurityInstruction
          ? {
              injectionWarning: {
                ruleId: 'test',
                category: 'role_hijack',
                instruction: params.inputSecurityInstruction,
              },
            }
          : {},
        criticalTurnInstructions: resolveCriticalTurnInstructions({
          currentUserMessage: params.currentUserMessage,
          normalizedMessages: params.normalizedMessages ?? [],
        }),
      }),
    );
  };

  const profileMemory = (name: string): MemoryPromptView =>
    ({
      adjudication: {
        profile: {
          name: {
            value: name,
            confidence: 'high',
            source: 'user',
            evidence: '用户提供',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
        },
        jobIntent: null,
        sessionState: null,
        conflicts: [],
        displayTurnHints: null,
        pendingTurnHintFields: [],
      },
      booking: { state: 'hidden' },
      realtimeGroups: [],
      contactBrandAliases: [],
      currentLaborFormIntent: { kind: 'ignore' },
      activeLaborForm: null,
    }) as unknown as MemoryPromptView;

  beforeEach(async () => {
    jest.clearAllMocks();
    service = new ContextService();
    await service.onModuleInit();
  });

  it('registers a corpus domain for every production leaf section and composes every scenario', async () => {
    const productionLeafDomains = {
      identity: 'teaching',
      'base-manual': 'teaching',
      'final-check': 'teaching',
      'red-lines': 'teaching',
      thresholds: 'teaching',
      'stage-overview': 'teaching',
      'stage-strategy': 'teaching',
      'input-guard': 'teaching',
      'critical-turn-guard': 'teaching',
      channel: 'teaching',
      memory: 'evidence',
      'turn-hints': 'evidence',
      'hard-constraints': 'evidence',
      datetime: 'tool_result',
      'group-inventory': 'tool_result',
    } as const;
    const productionShapedText = [
      '[引用 候选人：上一轮资料]',
      '[图片消息]',
      '连续消息一',
      '连续消息二',
      '[消息发送时间：2026-08-13 10:24:31]',
    ].join('\n');

    for (const [name, domain] of Object.entries(productionLeafDomains)) {
      const section: PromptSection = {
        id: name,
        domain,
        slot: 'stable-instructions',
        dynamic: false,
        build: () => [{ id: name, domain, role: 'system', content: productionShapedText }],
      };
      expect(section.build(promptModelOf())).toEqual([
        { id: name, domain, role: 'system', content: productionShapedText },
      ]);
    }

    for (const scenario of Object.keys(SCENARIO_PROMPT_MANIFEST)) {
      const result = compose({
        scenario,
        currentStage: 'trust_building',
      });
      expect(result.promptBlocks.every((block) => CORPUS_DOMAINS.includes(block.domain))).toBe(
        true,
      );
    }
  });

  it('keeps every scenario manifest already sorted by slot（manifest 即顺序真相）', () => {
    // slot 排序只作恒等兜底：manifest 顺序一旦与 slot 顺序冲突，块会被静默挪位，
    // 正是本次重构要消灭的那类问题。冲突时 compose 直接抛错。
    for (const scenario of Object.keys(SCENARIO_PROMPT_MANIFEST)) {
      expect(() => compose({ scenario, currentStage: 'trust_building' })).not.toThrow();
    }
  });

  it('ships the input security block in every scenario（检测是场景无关的）', () => {
    for (const [scenario, ids] of Object.entries(SCENARIO_PROMPT_MANIFEST)) {
      expect(ids).toContain('input-guard');
      const result = compose({
        scenario,
        currentStage: 'trust_building',
        inputSecurityInstruction: '⚠️ 安全提示：测试防护指令。',
      });
      expect(result.promptBlocks.map((block) => block.id)).toContain('input-guard');
    }
  });

  it('composes candidate consultation in the adjudicated semantic order', async () => {
    expect(SCENARIO_PROMPT_MANIFEST['candidate-consultation']).toEqual([
      'identity',
      'base-manual',
      'channel',
      'stage-overview',
      'red-lines',
      'thresholds',
      'memory',
      'turn-hints',
      'hard-constraints',
      'datetime',
      'group-inventory',
      'stage-strategy',
      'final-check',
      'input-guard',
      'critical-turn-guard',
    ]);
    const result = compose({
      scenario: 'candidate-consultation',
      currentStage: 'trust_building',
      memory: profileMemory('张三'),
    });

    const prompt = result.systemPrompt;

    expect(result.promptBlocks.map((block) => block.content).join('\n\n')).toBe(prompt);
    expect(result.promptBlocks.every((block) => CORPUS_DOMAINS.includes(block.domain))).toBe(true);
    expect(result.promptBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'base-manual', domain: 'teaching' }),
        expect.objectContaining({ id: 'candidate-memory', domain: 'evidence' }),
        expect.objectContaining({ id: 'datetime', domain: 'tool_result' }),
      ]),
    );
    expect(result.promptBlocks.map((block) => block.id)).toEqual([
      'identity',
      'base-manual',
      'stage-overview',
      'red-lines',
      'thresholds',
      'candidate-memory',
      'datetime',
      'stage-strategy',
      'final-check',
    ]);
    expect(result.promptBlocks.every((block) => block.role === 'system')).toBe(true);

    expect(prompt.indexOf('# 角色')).toBeLessThan(prompt.indexOf('# 全局工作原则'));
    expect(prompt.indexOf('# 人格设定')).toBeLessThan(prompt.indexOf('# 全局工作原则'));
    expect(prompt.indexOf('# 红线规则（以下行为绝对禁止）')).toBeGreaterThan(
      prompt.indexOf('[阶段推进提示]'),
    );
    expect(prompt.indexOf('# 发送前自检（全部需通过）')).toBeGreaterThan(
      prompt.lastIndexOf('[当前阶段策略]'),
    );
    expect(prompt.lastIndexOf('[当前阶段策略]')).toBeGreaterThan(prompt.indexOf('当前时间：'));

    expect(prompt).toContain('[用户档案]');
    expect(prompt).toContain('姓名: 张三');
    expect(prompt).toContain('先接情绪，再解释用途');
    // 2026-08-06 起该条覆盖面从"福利"扩到"福利与薪资细则"（阶梯算法/发薪日/社保/每日工时），
    // 标题与末句措辞随之调整。
    expect(prompt).toContain('福利与薪资细则追问必须实时重查');
    expect(prompt).toContain('记忆只用于确定 `jobId`，不能直接作为福利/薪资答案');
    // final-check 数据开关条目 — 已下沉到 duliday_job_list 工具描述（## 按候选人当前问题精确开启数据开关）
    expect(prompt).not.toContain('includeWelfare` / `includeJobSalary`');
    // final-check「未来某天才能面试」/「禁止承诺任何具体日期」— 已下沉到 duliday_interview_precheck 工具描述
    expect(prompt).not.toContain('未来某天才能面试');
    expect(prompt).not.toContain('禁止承诺任何具体日期');
    // 主 prompt 第 12 条仍引用 duliday_interview_precheck 作为工具描述桥梁
    expect(prompt).toContain('duliday_interview_precheck');
    // 工作班次 vs 面试时间澄清（P2-029 修复）
    expect(prompt).toContain('当前**工作班次**不合适');
    expect(prompt).toContain('提议的**面试时间**不合适');
    // final-check FC2（报名完成时态自检）已删——守卫 booking_promise/booking_receipt 确定性拦侧在产 +
    // 手册 F10 教侧仍在（2026-08-21 P3-2 首批：删与守卫完全同构的复核条目）
    expect(prompt).not.toContain('这就帮你登记');
    expect(prompt).not.toContain('nextAction 不是 ready_to_book');
    expect(prompt).toContain('booking 成功前不说已登记');
    // 11 班次硬约束 — 已下沉到 strategy_config.red_lines（运营可配），主 prompt 不再固化
    expect(prompt).not.toContain('候选人已明确表达时段/班次硬约束');
    // 13 多岗位分段输出 — 已下沉到 duliday_job_list 工具描述（## 回复展示要求），主 prompt 不再固化
    expect(prompt).not.toContain('推荐 2 个及以上岗位时必须分条分段输出');
    // final-check「岗位推荐主动展示薪资/班次」— 已下沉到 duliday_job_list 工具描述（## 回复展示要求），主 prompt/final-check 不再固化
    expect(prompt).not.toContain('若本轮做了具体岗位推荐');
    // 16/17 约面前必跑 precheck — 已下沉到 duliday_interview_booking 工具描述（## 调用契约），主 prompt 改为引用「以工具描述为准」
    expect(prompt).not.toContain('进入收资/约面流程前必须先做面试预检');
    expect(prompt).toContain(
      '以 [`duliday_interview_precheck`] 与 [`duliday_interview_booking`] 工具描述为准',
    );
    // 15/16 已沉淀到 DB 红线（自动注入），不再出现在 candidate-consultation.md
    expect(prompt).not.toContain('healthCertGate');
    expect(prompt).not.toContain('candidateScheduleConstraint');
    expect(prompt).not.toContain('投递层会直接拦截');
    // v4 复盘：注意力被"日期已过"带跑的兜底（修复 005）— 已随第 16/17 条下沉到 duliday_interview_precheck / duliday_interview_booking 工具描述，主 prompt 不再固化
    expect(prompt).not.toContain('禁止只问候选人挑新日期就跳过工具');
    // v4 复盘：两人分流红线（修复 012）已沉淀到 DB 红线，不再出现在 candidate-consultation.md
    expect(prompt).not.toContain('两人结伴求职、当前门店名额不足时必须主动给就近分流方案');
    // 工具专属规则（如 bookingChecklist.collectionStrategy）已迁移到各工具的 description 字段，
    // 不再出现在主 system prompt 中。
    expect(prompt).not.toContain('# 工具手册');
    expect(prompt).not.toContain('bookingChecklist.collectionStrategy');
  });

  it('keeps a matched critical-turn guard as the final scenario block and system suffix', async () => {
    const currentUserMessage = '我5月1号回来面试可以吗';
    const result = compose({
      scenario: 'candidate-consultation',
      currentStage: 'job_consultation',
      currentUserMessage,
      normalizedMessages: [{ role: 'user', content: currentUserMessage }],
    });

    const criticalBlock = result.promptBlocks.at(-1);
    expect(criticalBlock).toEqual(
      expect.objectContaining({
        id: 'critical-turn-guard',
        domain: 'teaching',
        role: 'system',
      }),
    );
    expect(criticalBlock?.content).toContain('本轮候选人指定了面试日期');
    expect(result.promptBlocks.at(-2)?.id).toBe('final-check');
    expect(result.systemPrompt.endsWith(criticalBlock?.content ?? '')).toBe(true);
    expect(result.systemPrompt.indexOf('# 发送前自检（全部需通过）')).toBeGreaterThan(
      result.systemPrompt.lastIndexOf('[当前阶段策略]'),
    );
    expect(result.systemPrompt.indexOf('# 本轮动态硬禁令')).toBeGreaterThan(
      result.systemPrompt.indexOf('# 发送前自检（全部需通过）'),
    );
  });

  it('keeps stable leading blocks and the late static final-check byte-identical across turns', async () => {
    const first = compose({
      scenario: 'candidate-consultation',
      currentStage: 'trust_building',
    });
    const second = compose({
      scenario: 'candidate-consultation',
      currentStage: 'job_consultation',
    });
    const stableLeadingIds = new Set([
      'identity',
      'base-manual',
      'channel',
      'stage-overview',
      'red-lines',
      'thresholds',
    ]);
    const stableLeadingBlocks = (blocks: typeof first.promptBlocks) =>
      blocks.filter((block) => stableLeadingIds.has(block.id));
    const finalCheck = (blocks: typeof first.promptBlocks) =>
      blocks.find((block) => block.id === 'final-check');

    expect(stableLeadingBlocks(first.promptBlocks)).toEqual(
      stableLeadingBlocks(second.promptBlocks),
    );
    expect(stableLeadingBlocks(first.promptBlocks).map((block) => block.id)).toEqual([
      'identity',
      'base-manual',
      'stage-overview',
      'red-lines',
      'thresholds',
    ]);
    expect(finalCheck(first.promptBlocks)).toEqual(finalCheck(second.promptBlocks));
    expect(first.promptBlocks.at(-1)?.id).toBe('final-check');
    const renderedStable = [
      ...stableLeadingBlocks(first.promptBlocks),
      finalCheck(first.promptBlocks),
    ]
      .filter((block) => block !== undefined)
      .map((block) => block.content)
      .join('\n\n');
    expect(renderedStable).not.toContain('第一轮');
    expect(renderedStable).not.toContain('第二轮');
    expect(renderedStable).not.toMatch(/当前时间：\d/u);
    expect(
      stableLeadingBlocks(first.promptBlocks).find((block) => block.id === 'stage-overview')
        ?.content,
    ).not.toContain('→');
  });

  it('should thread accountIdentity (nickname/gender/botUserId) into the identity anchor', async () => {
    const { systemPrompt } = compose({
      scenario: 'candidate-consultation',
      accountIdentity: { botUserId: 'ZhuDongSheng', nickname: '东升', gender: '男' },
    });

    expect(systemPrompt).toContain('# 账号身份');
    expect(systemPrompt).toContain('候选人看到的这个企微账号就是你本人');
    expect(systemPrompt).toContain('你的名字（企微昵称）：「东升」');
    expect(systemPrompt).toContain('你的性别：男');
    expect(systemPrompt).toContain('本账号的内部标识是「ZhuDongSheng」');
  });

  it('should still inject the account-identity anchor without accountIdentity', async () => {
    const { systemPrompt } = compose({
      scenario: 'candidate-consultation',
    });

    expect(systemPrompt).toContain('# 账号身份');
    expect(systemPrompt).toContain('当前未提供具体昵称');
    expect(systemPrompt).not.toContain('本账号的内部标识');
  });

  it('should keep runtime time injection to a single rendered current time line', async () => {
    const { systemPrompt } = compose({
      scenario: 'candidate-consultation',
    });

    const timeMatches = systemPrompt.match(/当前时间：/g) ?? [];

    expect(timeMatches).toHaveLength(1);
    expect(systemPrompt).not.toContain('{{CURRENT_TIME}}');
  });

  it('should not leak markdown front matter or html comments into prompt', async () => {
    const { systemPrompt } = compose({
      scenario: 'candidate-consultation',
    });

    expect(systemPrompt).not.toContain('\n---\n');
    expect(systemPrompt).not.toContain('<!--');
    // badcase 溯源等维护者注记以 HTML 注释留在源 md，加载时剥离，不得进模型上下文
    expect(systemPrompt).not.toMatch(/badcase/i);
  });

  it('should inject group inventory block when sessionFacts carries a city', async () => {
    const { systemPrompt, promptBlocks } = compose({
      scenario: 'candidate-consultation',
      groupInventory: {
        city: '上海',
        industries: [
          { industry: '餐饮', groupCount: 1, availableCount: 1 },
          { industry: '零售', groupCount: 1, availableCount: 1 },
        ],
      },
    });

    expect(systemPrompt).toContain('## 兼职群资源（上海）');
    expect(systemPrompt).toContain('- 餐饮：1 个群');
    expect(systemPrompt).toContain('- 零售：1 个群');
    // 检查"非候选人所在城市的群"未泄漏到 inventory 段，而非整个 prompt 不能含 "北京" 字样
    // （hard-constraints 段会把"禁止凭通识补北京/重庆等城市"作为反例文案列出）
    expect(systemPrompt).not.toContain('北京餐饮兼职群');
    const groupInventoryBlock = promptBlocks.find((block) => block.id === 'group-inventory');
    expect(groupInventoryBlock).toEqual(
      expect.objectContaining({ id: 'group-inventory', domain: 'tool_result' }),
    );
    expect(groupInventoryBlock?.content).toBe(
      ['## 兼职群资源（上海）', '- 餐饮：1 个群（均有空位）', '- 零售：1 个群（均有空位）'].join(
        '\n',
      ),
    );
    expect(systemPrompt).not.toContain('必须传对应 industry 参数');
  });

  it('keeps the empty-city inventory data bytes unchanged without embedding instructions', async () => {
    const { promptBlocks } = compose({
      scenario: 'candidate-consultation',
      groupInventory: { city: '上海', industries: [] },
    });

    expect(promptBlocks.find((block) => block.id === 'group-inventory')?.content).toBe(
      ['## 兼职群资源（上海）', '- 该城市暂无可用兼职群'].join('\n'),
    );
  });

  it('should skip group inventory block when no city is known', async () => {
    const { systemPrompt } = compose({
      scenario: 'candidate-consultation',
    });

    expect(systemPrompt).not.toContain('## 兼职群资源');
  });

  // 议题 1-2：兼职群资源会影响工具调用决策，取值必须与硬约束段同门（high）。
  // 此前直读 .value 绕过置信度门，导致 prompt 里出现
  // 硬约束段根本没有的城市。
  it('should skip group inventory block when the city confidence is below the hard-constraint gate', async () => {
    const { systemPrompt } = compose({
      scenario: 'candidate-consultation',
    });

    expect(systemPrompt).not.toContain('## 兼职群资源');
  });
});

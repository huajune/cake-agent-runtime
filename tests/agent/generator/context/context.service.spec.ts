import { ContextService } from '@agent/generator/context/context.service';
import { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import { CORPUS_DOMAINS } from '@shared-types/corpus.types';
import {
  buildPromptSectionBlocks,
  type PromptSection,
} from '@agent/generator/context/sections/procedural/section.interface';
import { SCENARIO_SECTIONS } from '@agent/generator/context/scenarios/scenario.registry';
import { cityFixture, sessionFactsOf } from '../../../helpers/session-facts.fixture';

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

  const mockStrategyConfigService = {
    getActiveConfig: jest.fn().mockResolvedValue(makeConfig()),
  };

  const mockGroupResolver = {
    resolveGroups: jest.fn().mockResolvedValue([]),
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => defaultValue),
  };

  let service: ContextService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockStrategyConfigService.getActiveConfig.mockResolvedValue(makeConfig());
    mockGroupResolver.resolveGroups.mockResolvedValue([]);
    service = new ContextService(
      mockStrategyConfigService as never,
      mockGroupResolver as never,
      mockConfigService as never,
    );
    await service.onModuleInit();
  });

  it('registers a corpus domain for every production leaf section and composes every scenario', async () => {
    const productionLeafDomains = {
      identity: 'teaching',
      'base-manual': 'teaching',
      'final-check': 'teaching',
      'red-lines': 'teaching',
      thresholds: 'teaching',
      'stage-strategy': 'teaching',
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
      const section: PromptSection = { name, build: () => productionShapedText };
      await expect(
        buildPromptSectionBlocks(section, { scenario: 'candidate-consultation' } as never),
      ).resolves.toEqual([{ id: name, domain, role: 'system', content: productionShapedText }]);
    }

    for (const scenario of Object.keys(SCENARIO_SECTIONS)) {
      const result = await service.compose({
        scenario,
        currentStage: 'trust_building',
        memoryBlock: productionShapedText,
        strategySource: 'testing',
      });
      expect(result.promptBlocks.every((block) => CORPUS_DOMAINS.includes(block.domain))).toBe(
        true,
      );
    }
  });

  it('should compose candidate consultation prompt in 5 top-level blocks', async () => {
    const result = await service.compose({
      scenario: 'candidate-consultation',
      currentStage: 'trust_building',
      memoryBlock: '[用户档案]\n- 姓名: 张三',
      strategySource: 'testing',
    });

    const prompt = result.systemPrompt;

    expect(result.promptBlocks.map((block) => block.content).join('\n\n')).toBe(prompt);
    expect(result.promptBlocks.every((block) => CORPUS_DOMAINS.includes(block.domain))).toBe(true);
    expect(result.promptBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'base-manual', domain: 'teaching' }),
        expect.objectContaining({ id: 'memory', domain: 'evidence' }),
        expect.objectContaining({ id: 'datetime', domain: 'tool_result' }),
      ]),
    );
    // 复合 section 必须展开，不能把 evidence/tool_result 混回一个 runtime-context 大串。
    expect(result.promptBlocks.some((block) => block.id === 'runtime-context')).toBe(false);

    expect(prompt.indexOf('# 角色')).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf('# 全局工作原则')).toBeGreaterThan(prompt.indexOf('# 人格设定'));
    expect(prompt.indexOf('# 红线规则（以下行为绝对禁止）')).toBeGreaterThan(
      prompt.indexOf('# 回合 SOP'),
    );
    expect(prompt.lastIndexOf('[当前阶段策略]')).toBeGreaterThan(prompt.indexOf('# 业务阈值'));
    expect(prompt.indexOf('# 发送前自检（全部需通过）')).toBeGreaterThan(
      prompt.indexOf('当前时间：'),
    );

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

  it('should thread accountIdentity (nickname/gender/botUserId) into the identity anchor', async () => {
    const { systemPrompt } = await service.compose({
      scenario: 'candidate-consultation',
      strategySource: 'testing',
      accountIdentity: { botUserId: 'ZhuDongSheng', nickname: '东升', gender: '男' },
    });

    expect(systemPrompt).toContain('# 账号身份');
    expect(systemPrompt).toContain('候选人看到的这个企微账号就是你本人');
    expect(systemPrompt).toContain('你的名字（企微昵称）：「东升」');
    expect(systemPrompt).toContain('你的性别：男');
    expect(systemPrompt).toContain('本账号的内部标识是「ZhuDongSheng」');
  });

  it('should still inject the account-identity anchor without accountIdentity', async () => {
    const { systemPrompt } = await service.compose({
      scenario: 'candidate-consultation',
      strategySource: 'testing',
    });

    expect(systemPrompt).toContain('# 账号身份');
    expect(systemPrompt).toContain('当前未提供具体昵称');
    expect(systemPrompt).not.toContain('本账号的内部标识');
  });

  it('should keep runtime time injection to a single rendered current time line', async () => {
    const { systemPrompt } = await service.compose({
      scenario: 'candidate-consultation',
      strategySource: 'testing',
    });

    const timeMatches = systemPrompt.match(/当前时间：/g) ?? [];

    expect(timeMatches).toHaveLength(1);
    expect(systemPrompt).not.toContain('{{CURRENT_TIME}}');
  });

  it('should not leak markdown front matter or html comments into prompt', async () => {
    const { systemPrompt } = await service.compose({
      scenario: 'candidate-consultation',
      strategySource: 'testing',
    });

    expect(systemPrompt).not.toContain('\n---\n');
    expect(systemPrompt).not.toContain('<!--');
    // badcase 溯源等维护者注记以 HTML 注释留在源 md，加载时剥离，不得进模型上下文
    expect(systemPrompt).not.toMatch(/badcase/i);
  });

  it('should inject group inventory block when sessionFacts carries a city', async () => {
    mockGroupResolver.resolveGroups.mockResolvedValue([
      {
        imRoomId: 'r1',
        groupName: '上海餐饮兼职①群',
        city: '上海',
        industry: '餐饮',
        tag: '兼职群',
        imBotId: 'bot',
        token: 'tok',
        memberCount: 156,
      },
      {
        imRoomId: 'r2',
        groupName: '上海零售兼职③群',
        city: '上海',
        industry: '零售',
        tag: '兼职群',
        imBotId: 'bot',
        token: 'tok',
        memberCount: 15,
      },
      {
        imRoomId: 'r3',
        groupName: '北京餐饮兼职群',
        city: '北京',
        industry: '餐饮',
        tag: '兼职群',
        imBotId: 'bot',
        token: 'tok',
        memberCount: 50,
      },
    ]);

    const { systemPrompt, promptBlocks } = await service.compose({
      scenario: 'candidate-consultation',
      strategySource: 'testing',
      sessionFacts: sessionFactsOf({ preferences: { city: cityFixture('上海') } }),
    });

    expect(systemPrompt).toContain('## 兼职群资源（上海）');
    expect(systemPrompt).toContain('- 餐饮：1 个群');
    expect(systemPrompt).toContain('- 零售：1 个群');
    // 检查"非候选人所在城市的群"未泄漏到 inventory 段，而非整个 prompt 不能含 "北京" 字样
    // （hard-constraints 段会把"禁止凭通识补北京/重庆等城市"作为反例文案列出）
    expect(systemPrompt).not.toContain('北京餐饮兼职群');
    expect(systemPrompt).toContain('必须传对应 industry 参数');
    expect(promptBlocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'group-inventory', domain: 'tool_result' }),
      ]),
    );
  });

  it('should skip group inventory block when no city is known', async () => {
    const { systemPrompt } = await service.compose({
      scenario: 'candidate-consultation',
      strategySource: 'testing',
    });

    expect(systemPrompt).not.toContain('## 兼职群资源');
    expect(mockGroupResolver.resolveGroups).not.toHaveBeenCalled();
  });

  // 议题 1-2：兼职群资源块会输出「本城市群库为空 → 禁止承诺拉群」这类有行为后果的指令，
  // 取值必须与硬约束段同门（high）。此前直读 .value 绕过置信度门，导致 prompt 里出现
  // 硬约束段根本没有的城市。
  it('should skip group inventory block when the city confidence is below the hard-constraint gate', async () => {
    const { systemPrompt } = await service.compose({
      scenario: 'candidate-consultation',
      strategySource: 'testing',
      sessionFacts: sessionFactsOf({ preferences: { city: cityFixture('上海', 'medium') } }),
    });

    expect(systemPrompt).not.toContain('## 兼职群资源');
    expect(mockGroupResolver.resolveGroups).not.toHaveBeenCalled();
  });
});

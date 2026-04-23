import { ContextService } from '@agent/context/context.service';
import { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';

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

  it('should compose candidate consultation prompt in 5 top-level blocks', async () => {
    const result = await service.compose({
      scenario: 'candidate-consultation',
      currentStage: 'trust_building',
      memoryBlock: '[用户档案]\n- 姓名: 张三',
      strategySource: 'testing',
    });

    const prompt = result.systemPrompt;

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
    expect(prompt).toContain('includeWelfare=true');
    expect(prompt).toContain('includeJobSalary=true');
    expect(prompt).toContain('今天也能约');
    // 工具专属规则（如 bookingChecklist.collectionStrategy）已迁移到各工具的 description 字段，
    // 不再出现在主 system prompt 中。
    expect(prompt).not.toContain('# 工具手册');
    expect(prompt).not.toContain('bookingChecklist.collectionStrategy');
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

    const { systemPrompt } = await service.compose({
      scenario: 'candidate-consultation',
      strategySource: 'testing',
      sessionFacts: {
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
          city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
          district: null,
          location: null,
          labor_form: null,
        },
        reasoning: '',
      },
    });

    expect(systemPrompt).toContain('## 兼职群资源（上海）');
    expect(systemPrompt).toContain('- 餐饮：1 个群');
    expect(systemPrompt).toContain('- 零售：1 个群');
    expect(systemPrompt).not.toContain('北京');
    expect(systemPrompt).toContain('必须传对应 industry 参数');
  });

  it('should skip group inventory block when no city is known', async () => {
    const { systemPrompt } = await service.compose({
      scenario: 'candidate-consultation',
      strategySource: 'testing',
    });

    expect(systemPrompt).not.toContain('## 兼职群资源');
    expect(mockGroupResolver.resolveGroups).not.toHaveBeenCalled();
  });
});

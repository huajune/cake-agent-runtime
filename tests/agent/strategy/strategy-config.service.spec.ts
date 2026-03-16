import { Test, TestingModule } from '@nestjs/testing';
import { StrategyConfigService } from '@agent/strategy/strategy-config.service';
import { StrategyConfigService as BizStrategyConfigService } from '@biz/strategy/services/strategy-config.service';
import { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import {
  StrategyPersona,
  StrategyStageGoals,
  StrategyRedLines,
} from '@biz/strategy/types/strategy.types';

describe('StrategyConfigService (agent layer)', () => {
  let service: StrategyConfigService;
  let mockBizStrategyConfigService: jest.Mocked<BizStrategyConfigService>;

  const buildPersona = (withDimensions = true): StrategyPersona => ({
    textDimensions: withDimensions
      ? [
          {
            key: 'characterTraits',
            label: '角色特质',
            value: '真实自然，暖心可靠',
            group: 'style',
            placeholder: '',
          },
          {
            key: 'chatHabits',
            label: '聊天习惯',
            value: '短句直出，单点沟通',
            group: 'style',
            placeholder: '',
          },
        ]
      : [],
  });

  const buildStageGoals = (): StrategyStageGoals => ({
    stages: [
      {
        stage: 'trust_building',
        label: '建立信任',
        description: '破冰阶段',
        primaryGoal: '建立信任',
        successCriteria: ['候选人愿意继续沟通'],
        ctaStrategy: ['轻松友好'],
        disallowedActions: ['跳过介绍'],
      },
      {
        stage: 'job_consultation',
        label: '岗位咨询',
        description: '核心服务阶段',
        primaryGoal: '提供岗位信息',
        successCriteria: ['候选人确认岗位'],
        ctaStrategy: ['用工具查询'],
        disallowedActions: ['编造数据'],
      },
    ],
  });

  const buildRedLines = (): StrategyRedLines => ({
    rules: ['禁止向在校学生推荐岗位', '禁止编造薪资数据'],
  });

  const buildConfig = (): StrategyConfigRecord => ({
    id: 'config_001',
    name: '默认策略',
    description: '系统默认策略',
    persona: buildPersona(),
    stage_goals: buildStageGoals(),
    red_lines: buildRedLines(),
    industry_skills: { skills: [] },
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });

  beforeEach(async () => {
    mockBizStrategyConfigService = {
      getActiveConfig: jest.fn(),
      updatePersona: jest.fn(),
      updateStageGoals: jest.fn(),
      updateRedLines: jest.fn(),
    } as unknown as jest.Mocked<BizStrategyConfigService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StrategyConfigService,
        { provide: BizStrategyConfigService, useValue: mockBizStrategyConfigService },
      ],
    }).compile();

    service = module.get<StrategyConfigService>(StrategyConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getActiveConfig', () => {
    it('should delegate to the biz service', async () => {
      const config = buildConfig();
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(config);

      const result = await service.getActiveConfig();

      expect(result).toBe(config);
      expect(mockBizStrategyConfigService.getActiveConfig).toHaveBeenCalledTimes(1);
    });
  });

  describe('updatePersona', () => {
    it('should delegate persona update to the biz service', async () => {
      const config = buildConfig();
      const persona = buildPersona();
      mockBizStrategyConfigService.updatePersona.mockResolvedValue(config);

      const result = await service.updatePersona(persona);

      expect(result).toBe(config);
      expect(mockBizStrategyConfigService.updatePersona).toHaveBeenCalledWith(persona);
    });
  });

  describe('updateStageGoals', () => {
    it('should delegate stage goals update to the biz service', async () => {
      const config = buildConfig();
      const stageGoals = buildStageGoals();
      mockBizStrategyConfigService.updateStageGoals.mockResolvedValue(config);

      const result = await service.updateStageGoals(stageGoals);

      expect(result).toBe(config);
      expect(mockBizStrategyConfigService.updateStageGoals).toHaveBeenCalledWith(stageGoals);
    });
  });

  describe('updateRedLines', () => {
    it('should delegate red lines update to the biz service', async () => {
      const config = buildConfig();
      const redLines = buildRedLines();
      mockBizStrategyConfigService.updateRedLines.mockResolvedValue(config);

      const result = await service.updateRedLines(redLines);

      expect(result).toBe(config);
      expect(mockBizStrategyConfigService.updateRedLines).toHaveBeenCalledWith(redLines);
    });
  });

  describe('getPersonaPromptText', () => {
    it('should return formatted persona text from config', async () => {
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(buildConfig());

      const result = await service.getPersonaPromptText();

      expect(result).toContain('# 人格设定');
      expect(result).toContain('## 角色特质');
      expect(result).toContain('真实自然，暖心可靠');
    });

    it('should return empty string when no style dimensions', async () => {
      const config = buildConfig();
      config.persona = buildPersona(false);
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(config);

      const result = await service.getPersonaPromptText();

      expect(result).toBe('');
    });

    it('should skip dimensions with empty value', async () => {
      const config = buildConfig();
      config.persona = {
        textDimensions: [
          {
            key: 'other',
            label: 'Other',
            value: '', // empty value is filtered out
            group: 'style',
            placeholder: '',
          },
        ],
      };
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(config);

      const result = await service.getPersonaPromptText();

      expect(result).toBe('');
    });
  });

  describe('getRedLinesPromptText', () => {
    it('should return formatted red lines text', async () => {
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(buildConfig());

      const result = await service.getRedLinesPromptText();

      expect(result).toContain('# 红线规则');
      expect(result).toContain('禁止向在校学生推荐岗位');
      expect(result).toContain('禁止编造薪资数据');
    });

    it('should return empty string when no red line rules', async () => {
      const config = buildConfig();
      config.red_lines = { rules: [] };
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(config);

      const result = await service.getRedLinesPromptText();

      expect(result).toBe('');
    });
  });

  describe('composeSystemPrompt', () => {
    it('should compose systemPrompt from persona, basePrompt, and redLines', async () => {
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(buildConfig());

      const result = await service.composeSystemPrompt('This is the base prompt.');

      expect(result).toContain('# 人格设定');
      expect(result).toContain('This is the base prompt.');
      expect(result).toContain('# 红线规则');
    });

    it('should join sections with double newlines', async () => {
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(buildConfig());

      const result = await service.composeSystemPrompt('base');

      // Check sections are separated by double newlines
      expect(result).toContain('\n\n');
    });

    it('should omit persona section when no style dimensions', async () => {
      const config = buildConfig();
      config.persona = buildPersona(false);
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(config);

      const result = await service.composeSystemPrompt('base prompt');

      expect(result).not.toContain('# 人格设定');
      expect(result).toContain('base prompt');
    });

    it('should omit basePrompt section when empty string', async () => {
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(buildConfig());

      const result = await service.composeSystemPrompt('');

      // Should not have leading/trailing newlines from empty base
      expect(result.startsWith('\n\n')).toBe(false);
    });
  });

  describe('getStageGoalsForToolContext', () => {
    it('should return a map keyed by stage name', async () => {
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(buildConfig());

      const result = await service.getStageGoalsForToolContext();

      expect(result).toHaveProperty('trust_building');
      expect(result).toHaveProperty('job_consultation');
      expect(result['trust_building'].label).toBe('建立信任');
      expect(result['job_consultation'].label).toBe('岗位咨询');
    });

    it('should return empty map when no stages defined', async () => {
      const config = buildConfig();
      config.stage_goals = { stages: [] };
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(config);

      const result = await service.getStageGoalsForToolContext();

      expect(result).toEqual({});
    });
  });

  describe('composeSystemPromptAndStageGoals', () => {
    it('should return both systemPrompt and stageGoals in single call', async () => {
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(buildConfig());

      const result = await service.composeSystemPromptAndStageGoals('base prompt');

      expect(result).toHaveProperty('systemPrompt');
      expect(result).toHaveProperty('stageGoals');
      expect(result.systemPrompt).toContain('base prompt');
      expect(result.stageGoals).toHaveProperty('trust_building');
    });

    it('should only call getActiveConfig once', async () => {
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(buildConfig());

      await service.composeSystemPromptAndStageGoals('base prompt');

      // Should only be called once - avoids two serial DB calls
      expect(mockBizStrategyConfigService.getActiveConfig).toHaveBeenCalledTimes(1);
    });

    it('should produce same systemPrompt as composeSystemPrompt', async () => {
      const config = buildConfig();
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(config);

      const combined = await service.composeSystemPromptAndStageGoals('base');
      // Reset for separate call
      mockBizStrategyConfigService.getActiveConfig.mockResolvedValue(config);
      const separate = await service.composeSystemPrompt('base');

      expect(combined.systemPrompt).toBe(separate);
    });
  });
});

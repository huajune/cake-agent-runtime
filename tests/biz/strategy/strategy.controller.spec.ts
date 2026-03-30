import { Test, TestingModule } from '@nestjs/testing';
import { StrategyController } from '@biz/strategy/strategy.controller';
import { StrategyConfigService } from '@biz/strategy/services/strategy-config.service';

describe('StrategyController', () => {
  let controller: StrategyController;
  let strategyConfigService: StrategyConfigService;

  const mockStrategyConfigService = {
    getActiveConfig: jest.fn(),
    getTestingConfig: jest.fn(),
    getReleasedConfig: jest.fn(),
    updatePersona: jest.fn(),
    updateStageGoals: jest.fn(),
    updateRedLines: jest.fn(),
    publish: jest.fn(),
    getVersionHistory: jest.fn(),
    getChangelog: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StrategyController],
      providers: [
        {
          provide: StrategyConfigService,
          useValue: mockStrategyConfigService,
        },
      ],
    }).compile();

    controller = module.get<StrategyController>(StrategyController);
    strategyConfigService = module.get<StrategyConfigService>(StrategyConfigService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getActiveConfig', () => {
    it('should return the testing config by default', async () => {
      const mockConfig = {
        id: 'config-1',
        persona: { textDimensions: [] },
        stageGoals: { stages: [] },
        redLines: { rules: [] },
      };

      mockStrategyConfigService.getTestingConfig.mockResolvedValue(mockConfig);

      const result = await controller.getActiveConfig();

      expect(strategyConfigService.getTestingConfig).toHaveBeenCalled();
      expect(result).toEqual(mockConfig);
    });

    it('should return released config when status=released', async () => {
      const mockConfig = { id: 'config-released' };
      mockStrategyConfigService.getReleasedConfig.mockResolvedValue(mockConfig);

      const result = await controller.getActiveConfig('released');

      expect(strategyConfigService.getReleasedConfig).toHaveBeenCalled();
      expect(result).toEqual(mockConfig);
    });

    it('should propagate errors from strategyConfigService', async () => {
      mockStrategyConfigService.getTestingConfig.mockRejectedValue(new Error('Config not found'));

      await expect(controller.getActiveConfig()).rejects.toThrow('Config not found');
    });
  });

  describe('updatePersona', () => {
    it('should update persona config and return result with message', async () => {
      const personaBody = {
        textDimensions: [
          {
            key: 'tone',
            label: '语气',
            value: '亲切友好',
            placeholder: '请输入语气描述',
            group: 'style' as const,
          },
        ],
      };
      const mockUpdatedConfig = { id: 'config-1', persona: personaBody };

      mockStrategyConfigService.updatePersona.mockResolvedValue(mockUpdatedConfig);

      const result = await controller.updatePersona(personaBody);

      expect(strategyConfigService.updatePersona).toHaveBeenCalledWith(personaBody);
      expect(result).toEqual({ config: mockUpdatedConfig, message: '人格配置已更新' });
    });

    it('should propagate errors from strategyConfigService', async () => {
      mockStrategyConfigService.updatePersona.mockRejectedValue(new Error('Update failed'));

      await expect(controller.updatePersona({ textDimensions: [] })).rejects.toThrow(
        'Update failed',
      );
    });
  });

  describe('updateStageGoals', () => {
    it('should update stage goals and return result with message', async () => {
      const stageGoalsBody = {
        stages: [
          {
            stage: 'trust_building',
            label: '信任建立',
            description: '与客户建立信任关系',
            primaryGoal: '了解客户需求',
          },
        ],
      };
      const mockUpdatedConfig = { id: 'config-1', stageGoals: stageGoalsBody };

      mockStrategyConfigService.updateStageGoals.mockResolvedValue(mockUpdatedConfig);

      const result = await controller.updateStageGoals(stageGoalsBody as any);

      expect(strategyConfigService.updateStageGoals).toHaveBeenCalledWith(stageGoalsBody);
      expect(result).toEqual({ config: mockUpdatedConfig, message: '阶段目标配置已更新' });
    });

    it('should propagate errors from strategyConfigService', async () => {
      mockStrategyConfigService.updateStageGoals.mockRejectedValue(new Error('DB write failed'));

      await expect(controller.updateStageGoals({} as any)).rejects.toThrow('DB write failed');
    });
  });

  describe('updateRedLines', () => {
    it('should update red lines and return result with message', async () => {
      const redLinesBody = {
        rules: [
          {
            key: 'no_price_commitment',
            label: '不承诺价格',
            description: '不得向客户承诺具体价格',
            enabled: true,
          },
        ],
      };
      const mockUpdatedConfig = { id: 'config-1', redLines: redLinesBody };

      mockStrategyConfigService.updateRedLines.mockResolvedValue(mockUpdatedConfig);

      const result = await controller.updateRedLines(redLinesBody as any);

      expect(strategyConfigService.updateRedLines).toHaveBeenCalledWith(redLinesBody);
      expect(result).toEqual({ config: mockUpdatedConfig, message: '红线规则已更新' });
    });

    it('should propagate errors from strategyConfigService', async () => {
      mockStrategyConfigService.updateRedLines.mockRejectedValue(new Error('Validation error'));

      await expect(controller.updateRedLines({} as any)).rejects.toThrow('Validation error');
    });
  });
});

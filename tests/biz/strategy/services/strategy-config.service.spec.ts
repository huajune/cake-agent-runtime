import { Test, TestingModule } from '@nestjs/testing';
import { InternalServerErrorException } from '@nestjs/common';
import { StrategyConfigService } from '@biz/strategy/services/strategy-config.service';
import { StrategyConfigRepository } from '@biz/strategy/repositories/strategy-config.repository';
import { StrategyChangelogRepository } from '@biz/strategy/repositories/strategy-changelog.repository';
import { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';

describe('StrategyConfigService', () => {
  let service: StrategyConfigService;

  const mockStrategyConfigRepository = {
    findActiveConfig: jest.fn(),
    insertConfig: jest.fn(),
    updateConfigField: jest.fn(),
  };

  const mockChangelogRepository = {
    insertLog: jest.fn().mockResolvedValue(null),
    findByConfigId: jest.fn().mockResolvedValue([]),
  };

  const makeRecord = (overrides: Partial<StrategyConfigRecord> = {}): StrategyConfigRecord => ({
    id: 'config-1',
    name: '测试策略',
    description: '测试用策略配置',
    role_setting: { content: '你是招聘经理' },
    persona: { textDimensions: [{ key: 'test', label: '测试', value: '测试值', placeholder: '', group: 'style' as const }] },
    stage_goals: { stages: [{ stage: 'trust_building', label: '建立信任', description: '', primaryGoal: '', successCriteria: [], ctaStrategy: [], disallowedActions: [] }] },
    red_lines: { rules: ['测试规则'], thresholds: [] },
    industry_skills: { skills: [] },
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StrategyConfigService,
        { provide: StrategyConfigRepository, useValue: mockStrategyConfigRepository },
        { provide: StrategyChangelogRepository, useValue: mockChangelogRepository },
      ],
    }).compile();

    service = module.get<StrategyConfigService>(StrategyConfigService);

    jest.clearAllMocks();

    // Reset memory cache
    (service as any).cachedConfig = null;
    (service as any).cacheExpiry = 0;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== getActiveConfig ====================

  describe('getActiveConfig', () => {
    it('should return memory cached config when cache is valid', async () => {
      const cached = makeRecord({ id: 'cached-1' });
      (service as any).cachedConfig = cached;
      (service as any).cacheExpiry = Date.now() + 60_000;

      const result = await service.getActiveConfig();

      expect(result).toBe(cached);
      expect(mockStrategyConfigRepository.findActiveConfig).not.toHaveBeenCalled();
    });

    it('should load from DB when memory cache is expired', async () => {
      const dbRecord = makeRecord({ id: 'db-1' });
      mockStrategyConfigRepository.findActiveConfig.mockResolvedValue(dbRecord);

      const result = await service.getActiveConfig();

      expect(result).toEqual(dbRecord);
      expect(mockStrategyConfigRepository.findActiveConfig).toHaveBeenCalledTimes(1);
    });

    it('should throw when DB returns null (no config)', async () => {
      mockStrategyConfigRepository.findActiveConfig.mockResolvedValue(null);

      await expect(service.getActiveConfig()).rejects.toThrow(InternalServerErrorException);
    });

    it('should throw when DB fails', async () => {
      mockStrategyConfigRepository.findActiveConfig.mockRejectedValue(new Error('DB error'));

      await expect(service.getActiveConfig()).rejects.toThrow('DB error');
    });
  });

  // ==================== updatePersona ====================

  describe('updatePersona', () => {
    it('should update persona and refresh cache', async () => {
      const initialRecord = makeRecord();
      const updatedRecord = makeRecord({ id: 'updated-1' });
      (service as any).cachedConfig = initialRecord;
      (service as any).cacheExpiry = Date.now() + 60_000;

      const newPersona = {
        textDimensions: [
          {
            key: 'test',
            label: 'Test',
            value: 'test value',
            placeholder: 'placeholder',
            group: 'style' as const,
          },
        ],
      };

      mockStrategyConfigRepository.updateConfigField.mockResolvedValue(updatedRecord);

      const result = await service.updatePersona(newPersona);

      expect(result).toEqual(updatedRecord);
      expect(mockStrategyConfigRepository.updateConfigField).toHaveBeenCalledWith(
        initialRecord.id,
        { persona: newPersona },
      );
      // Cache should be updated
      expect((service as any).cachedConfig).toEqual(updatedRecord);
    });

    it('should throw error when textDimensions is missing', async () => {
      await expect(service.updatePersona({ textDimensions: null as any })).rejects.toThrow(
        '人格配置必须包含 textDimensions 数组',
      );
    });

    it('should throw error when textDimensions is not an array', async () => {
      await expect(service.updatePersona({ textDimensions: 'invalid' as any })).rejects.toThrow(
        '人格配置必须包含 textDimensions 数组',
      );
    });

    it('should throw error when update returns null (no match)', async () => {
      const initialRecord = makeRecord();
      (service as any).cachedConfig = initialRecord;
      (service as any).cacheExpiry = Date.now() + 60_000;

      const newPersona = {
        textDimensions: [
          {
            key: 'test',
            label: 'Test',
            value: 'val',
            placeholder: '',
            group: 'style' as const,
          },
        ],
      };

      mockStrategyConfigRepository.updateConfigField.mockResolvedValue(null);

      await expect(service.updatePersona(newPersona)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  // ==================== updateRoleSetting ====================

  describe('updateRoleSetting', () => {
    it('should update role setting and refresh cache', async () => {
      const initialRecord = makeRecord();
      const updatedRecord = makeRecord({ id: 'updated-role' });
      (service as any).cachedConfig = initialRecord;
      (service as any).cacheExpiry = Date.now() + 60_000;

      const newRoleSetting = { content: '你是一名专业的招聘顾问' };

      mockStrategyConfigRepository.updateConfigField.mockResolvedValue(updatedRecord);

      const result = await service.updateRoleSetting(newRoleSetting);

      expect(result).toEqual(updatedRecord);
      expect(mockStrategyConfigRepository.updateConfigField).toHaveBeenCalledWith(
        initialRecord.id,
        { role_setting: newRoleSetting },
      );
      expect((service as any).cachedConfig).toEqual(updatedRecord);
    });

    it('should throw InternalServerErrorException when update returns null (no match)', async () => {
      const initialRecord = makeRecord();
      (service as any).cachedConfig = initialRecord;
      (service as any).cacheExpiry = Date.now() + 60_000;

      mockStrategyConfigRepository.updateConfigField.mockResolvedValue(null);

      await expect(service.updateRoleSetting({ content: 'test' })).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  // ==================== updateStageGoals ====================

  describe('updateStageGoals', () => {
    it('should update stage goals and refresh cache', async () => {
      const initialRecord = makeRecord();
      const updatedRecord = makeRecord();
      (service as any).cachedConfig = initialRecord;
      (service as any).cacheExpiry = Date.now() + 60_000;

      const newStageGoals = { stages: [{ stage: 'trust_building', label: 'Test' } as any] };

      mockStrategyConfigRepository.updateConfigField.mockResolvedValue(updatedRecord);

      const result = await service.updateStageGoals(newStageGoals);

      expect(result).toEqual(updatedRecord);
      expect(mockStrategyConfigRepository.updateConfigField).toHaveBeenCalledWith(
        initialRecord.id,
        { stage_goals: newStageGoals },
      );
    });

    it('should throw error when stages is missing', async () => {
      await expect(service.updateStageGoals({ stages: null as any })).rejects.toThrow(
        '阶段目标配置必须包含 stages 数组',
      );
    });

    it('should throw error when update returns null (no match)', async () => {
      const initialRecord = makeRecord();
      (service as any).cachedConfig = initialRecord;
      (service as any).cacheExpiry = Date.now() + 60_000;

      mockStrategyConfigRepository.updateConfigField.mockResolvedValue(null);

      await expect(service.updateStageGoals({ stages: [] })).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  // ==================== updateRedLines ====================

  describe('updateRedLines', () => {
    it('should update red lines and refresh cache', async () => {
      const initialRecord = makeRecord();
      const updatedRecord = makeRecord();
      (service as any).cachedConfig = initialRecord;
      (service as any).cacheExpiry = Date.now() + 60_000;

      const newRedLines = { rules: ['rule1', 'rule2'] };

      mockStrategyConfigRepository.updateConfigField.mockResolvedValue(updatedRecord);

      const result = await service.updateRedLines(newRedLines);

      expect(result).toEqual(updatedRecord);
      expect(mockStrategyConfigRepository.updateConfigField).toHaveBeenCalledWith(
        initialRecord.id,
        { red_lines: newRedLines },
      );
    });

    it('should throw error when rules is missing', async () => {
      await expect(service.updateRedLines({ rules: null as any })).rejects.toThrow(
        '红线规则必须包含 rules 数组',
      );
    });

    it('should throw error when rules is not an array', async () => {
      await expect(service.updateRedLines({ rules: 'invalid' as any })).rejects.toThrow(
        '红线规则必须包含 rules 数组',
      );
    });

    it('should throw error when update returns null (no match)', async () => {
      const initialRecord = makeRecord();
      (service as any).cachedConfig = initialRecord;
      (service as any).cacheExpiry = Date.now() + 60_000;

      mockStrategyConfigRepository.updateConfigField.mockResolvedValue(null);

      await expect(service.updateRedLines({ rules: ['test'] })).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  // ==================== refreshCache ====================

  describe('refreshCache', () => {
    it('should clear memory cache', async () => {
      (service as any).cachedConfig = makeRecord();
      (service as any).cacheExpiry = Date.now() + 60_000;

      await service.refreshCache();

      expect((service as any).cachedConfig).toBeNull();
      expect((service as any).cacheExpiry).toBe(0);
    });
  });
});

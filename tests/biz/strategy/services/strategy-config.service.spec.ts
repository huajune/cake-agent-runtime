import { Test, TestingModule } from '@nestjs/testing';
import { StrategyConfigService } from '@biz/strategy/services/strategy-config.service';
import { StrategyConfigRepository } from '@biz/strategy/repositories/strategy-config.repository';
import { StrategyConfigRecord } from '@biz/strategy/entities/strategy-config.entity';
import { buildDefaultStrategyRecord } from '@shared-types/strategy-config.types';

describe('StrategyConfigService', () => {
  let service: StrategyConfigService;

  const mockStrategyConfigRepository = {
    findActiveConfig: jest.fn(),
    insertConfig: jest.fn(),
    updateConfigField: jest.fn(),
  };

  const makeRecord = (overrides: Partial<StrategyConfigRecord> = {}): StrategyConfigRecord => ({
    id: 'config-1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...buildDefaultStrategyRecord(),
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StrategyConfigService,
        { provide: StrategyConfigRepository, useValue: mockStrategyConfigRepository },
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

    it('should seed defaults when DB returns null (first run)', async () => {
      const insertedRecord = makeRecord({ id: 'seeded-1' });
      mockStrategyConfigRepository.findActiveConfig.mockResolvedValue(null);
      mockStrategyConfigRepository.insertConfig.mockResolvedValue(insertedRecord);

      const result = await service.getActiveConfig();

      expect(result).toEqual(insertedRecord);
      expect(mockStrategyConfigRepository.insertConfig).toHaveBeenCalledTimes(1);
    });

    it('should query DB again when insert fails (concurrent conflict)', async () => {
      const existingRecord = makeRecord({ id: 'existing-1' });
      mockStrategyConfigRepository.findActiveConfig
        .mockResolvedValueOnce(null) // First call returns null (triggers seed)
        .mockResolvedValueOnce(existingRecord); // Second call returns existing
      mockStrategyConfigRepository.insertConfig.mockResolvedValue(null); // Insert fails

      const result = await service.getActiveConfig();

      expect(result).toEqual(existingRecord);
      expect(mockStrategyConfigRepository.findActiveConfig).toHaveBeenCalledTimes(2);
    });

    it('should return fallback record when DB fails', async () => {
      mockStrategyConfigRepository.findActiveConfig.mockRejectedValue(new Error('DB error'));

      const result = await service.getActiveConfig();

      expect(result.id).toBe('fallback');
    });

    it('should return fallback when insert and re-query both fail', async () => {
      mockStrategyConfigRepository.findActiveConfig
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null); // Re-query also returns null
      mockStrategyConfigRepository.insertConfig.mockResolvedValue(null);

      const result = await service.getActiveConfig();

      expect(result.id).toBe('fallback');
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

    it('should return current cache when update returns null (no match)', async () => {
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

      const result = await service.updatePersona(newPersona);

      expect(result).toEqual(initialRecord);
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

    it('should return current cache when update returns null', async () => {
      const initialRecord = makeRecord();
      (service as any).cachedConfig = initialRecord;
      (service as any).cacheExpiry = Date.now() + 60_000;

      mockStrategyConfigRepository.updateConfigField.mockResolvedValue(null);

      const result = await service.updateStageGoals({ stages: [] });

      expect(result).toEqual(initialRecord);
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

    it('should return current cache when update returns null', async () => {
      const initialRecord = makeRecord();
      (service as any).cachedConfig = initialRecord;
      (service as any).cacheExpiry = Date.now() + 60_000;

      mockStrategyConfigRepository.updateConfigField.mockResolvedValue(null);

      const result = await service.updateRedLines({ rules: ['test'] });

      expect(result).toEqual(initialRecord);
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

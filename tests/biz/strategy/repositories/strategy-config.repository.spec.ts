import { Test, TestingModule } from '@nestjs/testing';
import { StrategyConfigRepository } from '@biz/strategy/repositories/strategy-config.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';

function makeQueryMock(result: { data?: unknown; error?: unknown; count?: number }) {
  const chainMethods = [
    'select',
    'insert',
    'update',
    'upsert',
    'delete',
    'eq',
    'neq',
    'gte',
    'lte',
    'gt',
    'lt',
    'in',
    'or',
    'order',
    'limit',
    'range',
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mock: any = Object.assign(Promise.resolve(result), {});
  for (const m of chainMethods) {
    mock[m] = jest.fn().mockReturnValue(mock);
  }
  return mock;
}

const sampleConfig = {
  id: 'cfg_001',
  name: 'Default Strategy',
  description: null,
  persona: { role: 'assistant' },
  stage_goals: {},
  red_lines: {},
  industry_skills: {},
  is_active: true,
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-01T00:00:00Z',
};

describe('StrategyConfigRepository', () => {
  let repository: StrategyConfigRepository;

  const mockSupabaseClient = {
    from: jest.fn(),
    rpc: jest.fn(),
  };

  const mockSupabaseService = {
    getSupabaseClient: jest.fn().mockReturnValue(mockSupabaseClient),
    isClientInitialized: jest.fn().mockReturnValue(true),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSupabaseService.getSupabaseClient.mockReturnValue(mockSupabaseClient);
    mockSupabaseService.isClientInitialized.mockReturnValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StrategyConfigRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<StrategyConfigRepository>(StrategyConfigRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== findActiveConfig ====================

  describe('findActiveConfig', () => {
    it('should return null when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.findActiveConfig();

      expect(result).toBeNull();
    });

    it('should return active config when it exists', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [sampleConfig], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findActiveConfig();

      expect(result).toEqual(sampleConfig);
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('strategy_config');
    });

    it('should return null when no active config exists', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findActiveConfig();

      expect(result).toBeNull();
    });

    it('should return null on database error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findActiveConfig();

      expect(result).toBeNull();
    });
  });

  // ==================== insertConfig ====================

  describe('insertConfig', () => {
    it('should return null when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.insertConfig({ model: 'gpt-4', is_active: true });

      expect(result).toBeNull();
    });

    it('should insert and return new config', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const insertResult = makeQueryMock({ data: [sampleConfig], error: null });
      mockSupabaseClient.from.mockReturnValue(insertResult);

      const result = await repository.insertConfig({
        name: 'Default Strategy',
        is_active: true,
        persona: { role: 'assistant' },
      });

      expect(result).toEqual(sampleConfig);
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('strategy_config');
    });

    it('should return null on duplicate key error (conflict)', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const conflictResult = makeQueryMock({
        data: null,
        error: { code: '23505', message: 'unique violation' },
      });
      mockSupabaseClient.from.mockReturnValue(conflictResult);

      const result = await repository.insertConfig({ name: 'Strategy', is_active: true });

      expect(result).toBeNull();
    });

    it('should return null on insert error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const errorResult = makeQueryMock({
        data: null,
        error: { code: '42P01', message: 'table not found' },
      });
      mockSupabaseClient.from.mockReturnValue(errorResult);

      const result = await repository.insertConfig({ name: 'Strategy' });

      expect(result).toBeNull();
    });
  });

  // ==================== updateConfigField ====================

  describe('updateConfigField', () => {
    it('should return null when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.updateConfigField('cfg_001', { name: 'Updated Strategy' });

      expect(result).toBeNull();
    });

    it('should update and return updated config', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updatedConfig = { ...sampleConfig, name: 'Updated Strategy' };
      const updateResult = makeQueryMock({ data: [updatedConfig], error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      const result = await repository.updateConfigField('cfg_001', { name: 'Updated Strategy' });

      expect(result).toEqual(updatedConfig);
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('strategy_config');
    });

    it('should return null when no record matches the id', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updateResult = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      const result = await repository.updateConfigField('nonexistent', { name: 'Strategy X' });

      expect(result).toBeNull();
    });

    it('should return null on update error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const errorResult = makeQueryMock({ data: null, error: { code: '42P01', message: 'error' } });
      mockSupabaseClient.from.mockReturnValue(errorResult);

      const result = await repository.updateConfigField('cfg_001', { is_active: false });

      expect(result).toBeNull();
    });

    it('should update is_active field', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const deactivatedConfig = { ...sampleConfig, is_active: false };
      const updateResult = makeQueryMock({ data: [deactivatedConfig], error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      const result = await repository.updateConfigField('cfg_001', { is_active: false });

      expect(result?.is_active).toBe(false);
    });
  });
});

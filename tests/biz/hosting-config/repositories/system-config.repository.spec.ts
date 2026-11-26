import { Test, TestingModule } from '@nestjs/testing';
import { SystemConfigRepository } from '@biz/hosting-config/repositories/system-config.repository';
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

describe('SystemConfigRepository', () => {
  let repository: SystemConfigRepository;

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
        SystemConfigRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<SystemConfigRepository>(SystemConfigRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  it('persists a worker change in one upsert and requires a returned row', async () => {
    const row = { key: 'system_config', value: { workerConcurrency: 50 }, description: 'Worker' };
    const query = makeQueryMock({ data: [row], error: null });
    mockSupabaseClient.from.mockReturnValue(query);
    await repository.setConfigValueOrThrow(row.key, row.value, row.description);
    expect(query.upsert).toHaveBeenCalledWith(row, { onConflict: 'key' });
    mockSupabaseClient.from.mockReturnValue(makeQueryMock({ data: [], error: null }));
    await expect(
      repository.setConfigValueOrThrow(row.key, row.value, row.description),
    ).rejects.toThrow('写入系统配置失败');
  });

  // ==================== getConfigValue ====================

  describe('getConfigValue', () => {
    it('should return null when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getConfigValue('some_key');

      expect(result).toBeNull();
    });

    it('should return config value when key exists', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      const configValue = { enabled: true, threshold: 0.8 };

      const queryMock = makeQueryMock({ data: [{ value: configValue }], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getConfigValue<{ enabled: boolean; threshold: number }>(
        'ai_config',
      );

      expect(result).toEqual(configValue);
    });

    it('should return null when key does not exist', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getConfigValue('nonexistent_key');

      expect(result).toBeNull();
    });

    it('should return null on database error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getConfigValue('some_key');

      expect(result).toBeNull();
    });

    it('should return string config value', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [{ value: 'hello world' }], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getConfigValue<string>('greeting');

      expect(result).toBe('hello world');
    });

    it('should return boolean false value without mistaking it for null', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [{ value: false }], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getConfigValue<boolean>('feature_flag');

      expect(result).toBe(false);
    });
  });

  // ==================== setConfigValue ====================

  describe('getConfigValueOrThrow', () => {
    it('returns null only when the requested config row is absent', async () => {
      const query = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(query);
      await expect(repository.getConfigValueOrThrow('agent_reply_config')).resolves.toBeNull();
      expect(query.select).toHaveBeenCalledWith('value');
      expect(query.eq).toHaveBeenCalledWith('key', 'agent_reply_config');
      expect(query.limit).toHaveBeenCalledWith(1);
    });

    it('preserves the saved model chain without converting it to a default', async () => {
      const value = { defaultFallbackModelIds: ['deepseek/deepseek-v4-pro'] };
      mockSupabaseClient.from.mockReturnValue(makeQueryMock({ data: [{ value }], error: null }));
      await expect(repository.getConfigValueOrThrow('agent_reply_config')).resolves.toEqual(value);
    });

    it('throws on database failure so the caller can retain its last successful config', async () => {
      mockSupabaseClient.from.mockReturnValue(
        makeQueryMock({ data: null, error: { message: 'permission denied', code: '42501' } }),
      );
      await expect(repository.getConfigValueOrThrow('agent_reply_config')).rejects.toThrow(
        '读取系统配置失败: agent_reply_config',
      );
    });

    it('throws when the database client is unavailable', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);
      await expect(repository.getConfigValueOrThrow('agent_reply_config')).rejects.toThrow(
        '读取系统配置失败',
      );
      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });
  });

  describe('setConfigValue', () => {
    it('should skip write when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      await repository.setConfigValue('test_key', 'test_value');

      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should update existing config when key already exists', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updateResult = makeQueryMock({
        data: [{ key: 'existing_key', value: 'new_value' }],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      await repository.setConfigValue('existing_key', 'new_value');

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('system_config');
    });

    it('should insert new config when key does not exist', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      // update returns empty → triggers insert
      const emptyUpdateResult = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(emptyUpdateResult);

      await repository.setConfigValue('new_key', { setting: 'value' }, 'A new setting');

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('system_config');
    });

    it('should handle complex object values', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      const complexValue = { nested: { deep: [1, 2, 3] }, flag: true };

      const updateResult = makeQueryMock({
        data: [{ key: 'complex_key', value: complexValue }],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      await expect(repository.setConfigValue('complex_key', complexValue)).resolves.not.toThrow();
    });

    it('should handle null value', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updateResult = makeQueryMock({
        data: [{ key: 'nullable_key', value: null }],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      await expect(repository.setConfigValue('nullable_key', null)).resolves.not.toThrow();
    });
  });
});

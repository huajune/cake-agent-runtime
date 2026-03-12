import { Test, TestingModule } from '@nestjs/testing';
import { GroupBlacklistRepository } from './group-blacklist.repository';
import { SupabaseService } from '@core/supabase';

/**
 * Helper: create a chainable Supabase query mock that resolves to a given result.
 */
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

describe('GroupBlacklistRepository', () => {
  let repository: GroupBlacklistRepository;

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
        GroupBlacklistRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<GroupBlacklistRepository>(GroupBlacklistRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== loadBlacklistFromDb ====================

  describe('loadBlacklistFromDb', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.loadBlacklistFromDb();

      expect(result).toEqual([]);
    });

    it('should return blacklist items when record exists', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      const blacklistItems = [
        { group_id: 'group_001', reason: 'spam', added_at: 1700000000000 },
        { group_id: 'group_002', added_at: 1700000001000 },
      ];

      const queryMock = makeQueryMock({ data: [{ value: blacklistItems }], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.loadBlacklistFromDb();

      expect(result).toEqual(blacklistItems);
    });

    it('should return empty array when no record exists', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.loadBlacklistFromDb();

      expect(result).toEqual([]);
    });

    it('should return empty array when value is not an array', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [{ value: null }], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.loadBlacklistFromDb();

      expect(result).toEqual([]);
    });

    it('should return empty array on database error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.loadBlacklistFromDb();

      expect(result).toEqual([]);
    });
  });

  // ==================== saveBlacklistToDb ====================

  describe('saveBlacklistToDb', () => {
    it('should skip save when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      await repository.saveBlacklistToDb([]);

      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should update existing record when record exists', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      const items = [{ group_id: 'group_001', added_at: 1700000000000 }];

      // update returns the updated records (non-empty means update happened)
      const updateResult = makeQueryMock({
        data: [{ key: 'group_blacklist', value: items }],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      await repository.saveBlacklistToDb(items);

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('system_config');
    });

    it('should insert new record when no existing record is updated', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      const items = [{ group_id: 'group_001', added_at: 1700000000000 }];

      // update returns empty array (no rows updated) → triggers insert
      const emptyUpdateResult = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(emptyUpdateResult);

      await repository.saveBlacklistToDb(items);

      // from() is called at least twice: once for update, once for insert
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('system_config');
    });

    it('should handle empty items array', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updateResult = makeQueryMock({
        data: [{ key: 'group_blacklist', value: [] }],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      await expect(repository.saveBlacklistToDb([])).resolves.not.toThrow();
    });
  });
});

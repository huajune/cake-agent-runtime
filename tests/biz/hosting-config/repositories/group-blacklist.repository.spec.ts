import { Test, TestingModule } from '@nestjs/testing';
import { GroupBlacklistRepository } from '@biz/hosting-config/repositories/group-blacklist.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';

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
    'abortSignal',
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

  it('updates only the target group through the atomic RPC and reports failures', async () => {
    const items = [{ group_id: 'other', added_at: 1 }];
    mockSupabaseClient.rpc.mockReturnValue(makeQueryMock({ data: items, error: null }));
    expect(await repository.setGroupBlacklisted('own', false)).toEqual(items);
    expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('set_hosting_group_blacklisted', {
      p_group_id: 'own',
      p_blacklisted: false,
      p_reason: null,
    });
    expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    mockSupabaseClient.rpc.mockReturnValue(
      makeQueryMock({ data: null, error: { message: 'failed' } }),
    );
    await expect(repository.setGroupBlacklisted('own', true)).rejects.toThrow('保存失败');
  });

  // ==================== loadBlacklistFromDb ====================

  describe('loadBlacklistFromDb', () => {
    it('should return null (unreadable) when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.loadBlacklistFromDb();

      expect(result).toBeNull();
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

    it('should treat malformed persisted data as unreadable', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [{ value: null }], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.loadBlacklistFromDb();

      expect(result).toBeNull();
    });

    it('should return null (unreadable) on database error instead of an empty blacklist', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.loadBlacklistFromDb();

      expect(result).toBeNull();
    });

    it('retries a transient gateway error before giving the blacklist back', async () => {
      const blacklistItems = [{ group_id: 'group_001', added_at: 1700000000000 }];
      mockSupabaseClient.from
        .mockReturnValueOnce(
          makeQueryMock({ data: null, error: { message: '503 Service Unavailable' } }),
        )
        .mockReturnValueOnce(makeQueryMock({ data: [{ value: blacklistItems }], error: null }));

      const result = await repository.loadBlacklistFromDb();

      expect(mockSupabaseClient.from).toHaveBeenCalledTimes(2);
      expect(result).toEqual(blacklistItems);
    });

    it('returns null after the transient retry is exhausted', async () => {
      mockSupabaseClient.from.mockReturnValue(
        makeQueryMock({ data: null, error: { message: '503 Service Unavailable' } }),
      );

      const result = await repository.loadBlacklistFromDb();

      expect(mockSupabaseClient.from).toHaveBeenCalledTimes(2);
      expect(result).toBeNull();
    });

    it('should return null (unreadable) when the query throws', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      mockSupabaseClient.from.mockImplementation(() => {
        throw new Error('network down');
      });

      const result = await repository.loadBlacklistFromDb();

      expect(result).toBeNull();
    });
  });
});

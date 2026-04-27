import { Test, TestingModule } from '@nestjs/testing';
import { UserHostingRepository } from '@biz/user/repositories/user-hosting.repository';
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

describe('UserHostingRepository', () => {
  let repository: UserHostingRepository;

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
        UserHostingRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<UserHostingRepository>(UserHostingRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== findPausedUserIds ====================

  describe('findPausedUserIds', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.findPausedUserIds();

      expect(result).toEqual([]);
    });

    it('should return paused users ordered by paused_at descending', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const dbRows = [
        { user_id: 'user_001', paused_at: '2026-03-10T10:00:00Z' },
        { user_id: 'user_002', paused_at: '2026-03-09T09:00:00Z' },
      ];

      const queryMock = makeQueryMock({ data: dbRows, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findPausedUserIds();

      expect(result).toHaveLength(2);
      expect(result[0].user_id).toBe('user_001');
      expect(result[1].user_id).toBe('user_002');
    });

    it('should return empty array when no users are paused', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findPausedUserIds();

      expect(result).toEqual([]);
    });

    it('should return empty array on database error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findPausedUserIds();

      expect(result).toEqual([]);
    });
  });

  // ==================== upsertPause ====================

  describe('upsertPause', () => {
    it('should skip when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const pausedAt = new Date().toISOString();
      const pauseExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      await repository.upsertPause('user_001', pausedAt, pauseExpiresAt);

      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should upsert pause record', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const upsertResult = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(upsertResult);

      const pausedAt = new Date().toISOString();
      const pauseExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      await repository.upsertPause('user_001', pausedAt, pauseExpiresAt);

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('user_hosting_status');
    });

    it('should not throw on upsert error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const errorResult = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(errorResult);

      const pausedAt = new Date().toISOString();
      const pauseExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      await expect(
        repository.upsertPause('user_001', pausedAt, pauseExpiresAt),
      ).resolves.not.toThrow();
    });
  });

  // ==================== updateResume ====================

  describe('updateResume', () => {
    it('should skip when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      await repository.updateResume('user_001');

      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should update user to resumed state', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updateResult = makeQueryMock({
        data: [{ user_id: 'user_001', is_paused: false }],
        error: null,
      });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      await repository.updateResume('user_001');

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('user_hosting_status');
    });

    it('should not throw when user not found', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updateResult = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      await expect(repository.updateResume('nonexistent')).resolves.not.toThrow();
    });
  });

  // ==================== findUserProfiles ====================

  describe('findUserProfiles', () => {
    it('should return empty array when userIds is empty', async () => {
      const result = await repository.findUserProfiles([]);

      expect(result).toEqual([]);
      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should return mapped user profiles', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const dbRows = [
        {
          chat_id: 'user_001',
          od_name: 'Alice',
          group_name: 'Team A',
          bot_user_id: 'bot-a',
          im_bot_id: 'im-bot-a',
        },
        { chat_id: 'user_002', od_name: 'Bob', group_name: 'Team B' },
      ];

      const selectChain = {
        select: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        order: jest.fn().mockResolvedValue({ data: dbRows, error: null }),
      };
      mockSupabaseClient.from.mockReturnValue(selectChain);

      const result = await repository.findUserProfiles(['user_001', 'user_002']);

      expect(result).toHaveLength(2);
      expect(result[0].chatId).toBe('user_001');
      expect(result[0].odName).toBe('Alice');
      expect(result[0].groupName).toBe('Team A');
      expect(result[0].botUserId).toBe('bot-a');
      expect(result[0].imBotId).toBe('im-bot-a');
      expect(result[1].chatId).toBe('user_002');
    });

    it('should return empty array on database error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const selectChain = {
        select: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        order: jest.fn().mockResolvedValue({
          data: null,
          error: { message: 'DB error', code: '42P01' },
        }),
      };
      mockSupabaseClient.from.mockReturnValue(selectChain);

      const result = await repository.findUserProfiles(['user_001']);

      expect(result).toEqual([]);
    });

    it('should handle users with missing optional profile fields', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const dbRows = [{ chat_id: 'user_001', od_name: undefined, group_name: undefined }];

      const selectChain = {
        select: jest.fn().mockReturnThis(),
        in: jest.fn().mockReturnThis(),
        order: jest.fn().mockResolvedValue({ data: dbRows, error: null }),
      };
      mockSupabaseClient.from.mockReturnValue(selectChain);

      const result = await repository.findUserProfiles(['user_001']);

      expect(result).toHaveLength(1);
      expect(result[0].odName).toBeUndefined();
      expect(result[0].groupName).toBeUndefined();
    });
  });

  // ==================== upsertUserActivity ====================

  describe('upsertUserActivity', () => {
    it('should skip when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      await repository.upsertUserActivity({ chatId: 'user_001' });

      expect(mockSupabaseClient.rpc).not.toHaveBeenCalled();
    });

    it('should call RPC with correct params', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      const activeAt = new Date();
      await repository.upsertUserActivity({
        chatId: 'user_001',
        odId: 'od_001',
        odName: 'Alice',
        groupId: 'group_001',
        groupName: 'Team A',
        botUserId: 'bot-a',
        imBotId: 'im-bot-a',
        messageCount: 5,
        totalTokens: 500,
        activeAt,
      });

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('upsert_user_activity', {
        p_chat_id: 'user_001',
        p_od_id: 'od_001',
        p_od_name: 'Alice',
        p_group_id: 'group_001',
        p_group_name: 'Team A',
        p_message_count: 5,
        p_token_usage: 500,
        p_active_at: activeAt.toISOString(),
        p_bot_user_id: 'bot-a',
        p_im_bot_id: 'im-bot-a',
      });
    });

    it('should use defaults for missing optional params', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      await repository.upsertUserActivity({ chatId: 'user_001' });

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith(
        'upsert_user_activity',
        expect.objectContaining({
          p_chat_id: 'user_001',
          p_od_id: null,
          p_od_name: null,
          p_group_id: null,
          p_group_name: null,
          p_bot_user_id: null,
          p_im_bot_id: null,
          p_message_count: 1,
          p_token_usage: 0,
        }),
      );
    });

    it('should not throw on RPC error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockRejectedValue(new Error('RPC failed'));

      await expect(repository.upsertUserActivity({ chatId: 'user_001' })).resolves.not.toThrow();
    });
  });

  // ==================== cleanupUserActivity ====================

  describe('cleanupUserActivity', () => {
    it('should return 0 when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.cleanupUserActivity(14);

      expect(result).toBe(0);
    });

    it('should return deleted count from RPC', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: 15, error: null });

      const result = await repository.cleanupUserActivity(14);

      expect(result).toBe(15);
      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('cleanup_user_activity', {
        retention_days: 14,
      });
    });

    it('should use default retentionDays of 14', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: 0, error: null });

      await repository.cleanupUserActivity();

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('cleanup_user_activity', {
        retention_days: 14,
      });
    });

    it('should return 0 when RPC returns null', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      const result = await repository.cleanupUserActivity(14);

      expect(result).toBe(0);
    });

    it('should return 0 and not throw on RPC error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      mockSupabaseClient.rpc.mockRejectedValue(new Error('RPC failed'));

      const result = await repository.cleanupUserActivity(14);

      expect(result).toBe(0);
    });
  });
});

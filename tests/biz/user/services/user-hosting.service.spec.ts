import { Test, TestingModule } from '@nestjs/testing';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { UserHostingRepository } from '@biz/user/repositories/user-hosting.repository';
import { RedisService } from '@infra/redis/redis.service';

describe('UserHostingService', () => {
  let service: UserHostingService;

  const mockUserHostingRepository = {
    findPausedUserIds: jest.fn(),
    upsertPause: jest.fn(),
    updateResume: jest.fn(),
    findUserProfiles: jest.fn(),
    expirePausedUsers: jest.fn(),
  };

  const mockRedisService = {
    get: jest.fn(),
    set: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserHostingService,
        { provide: UserHostingRepository, useValue: mockUserHostingRepository },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get<UserHostingService>(UserHostingService);

    jest.clearAllMocks();
    mockRedisService.get.mockResolvedValue(null);
    mockRedisService.set.mockResolvedValue(undefined);
    mockUserHostingRepository.findPausedUserIds.mockResolvedValue([]);
    mockUserHostingRepository.expirePausedUsers.mockResolvedValue([]);

    // Reset cache
    (service as any).pausedUsersCache.clear();
    (service as any).cacheExpiry = 0;
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== isUserPaused ====================

  describe('isUserPaused', () => {
    it('should return true for a paused user (from DB)', async () => {
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([
        { user_id: 'user1', paused_at: new Date().toISOString() },
      ]);

      const result = await service.isUserPaused('user1');

      expect(result).toBe(true);
      expect(mockUserHostingRepository.findPausedUserIds).toHaveBeenCalledTimes(1);
    });

    it('should return false for a user not in paused list', async () => {
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([
        { user_id: 'user1', paused_at: new Date().toISOString() },
      ]);

      const result = await service.isUserPaused('user2');

      expect(result).toBe(false);
    });

    it('should use memory cache when cache is valid', async () => {
      // Warm the cache
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([
        { user_id: 'user1', paused_at: new Date().toISOString() },
      ]);
      await service.isUserPaused('user1'); // First call loads cache

      jest.clearAllMocks();

      // Second call should use memory cache
      const result = await service.isUserPaused('user1');

      expect(result).toBe(true);
      expect(mockUserHostingRepository.findPausedUserIds).not.toHaveBeenCalled();
    });

    it('should reload cache when cache is expired', async () => {
      (service as any).cacheExpiry = Date.now() - 1; // Force expiry
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([]);

      await service.isUserPaused('user1');

      expect(mockUserHostingRepository.findPausedUserIds).toHaveBeenCalledTimes(1);
    });

    it('should treat permanent pause rows (null expiry) as paused', async () => {
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([
        {
          user_id: 'user1',
          paused_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
          pause_expires_at: null,
          is_permanent: true,
          pause_reason: '客户微信',
        },
      ]);

      const result = await service.isUserPaused('user1');

      expect(result).toBe(true);
    });

    it('should return false and set backoff expiry when DB load fails', async () => {
      mockUserHostingRepository.findPausedUserIds.mockRejectedValue(new Error('DB error'));

      const result = await service.isUserPaused('user1');

      expect(result).toBe(false);
      // Should set a backoff expiry (~30 seconds)
      const expiry = (service as any).cacheExpiry;
      expect(expiry).toBeGreaterThan(Date.now());
      expect(expiry).toBeLessThanOrEqual(Date.now() + 30_000 + 100);
    });
  });

  // ==================== isAnyPaused ====================

  describe('isAnyPaused', () => {
    it('returns paused with the matched id when any input id is paused', async () => {
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([
        { user_id: 'external-1', paused_at: new Date().toISOString() },
      ]);

      const result = await service.isAnyPaused(['chat-1', 'contact-1', 'external-1']);

      expect(result).toEqual({ paused: true, matchedId: 'external-1' });
    });

    it('returns paused=false when none of the ids are paused', async () => {
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([]);

      const result = await service.isAnyPaused(['chat-1', 'contact-1', null, undefined]);

      expect(result).toEqual({ paused: false });
    });
  });

  // ==================== getPausedUserIdSet ====================

  describe('getPausedUserIdSet', () => {
    it('should return currently active paused user ids from the shared cache snapshot', async () => {
      const now = Date.now();
      (service as any).pausedUsersCache.set('user1', {
        isPaused: true,
        pausedAt: now,
        expiresAt: now + 3 * 24 * 60 * 60 * 1000,
      });
      (service as any).pausedUsersCache.set('expired-user', {
        isPaused: true,
        pausedAt: now - 4 * 24 * 60 * 60 * 1000,
        expiresAt: now - 1000,
      });
      (service as any).cacheExpiry = now + 60_000;

      const result = await service.getPausedUserIdSet();

      expect(result).toEqual(new Set(['user1']));
      expect(mockUserHostingRepository.findPausedUserIds).not.toHaveBeenCalled();
    });
  });

  // ==================== getUserHostingStatus ====================

  describe('getUserHostingStatus', () => {
    it('should return correct hosting status for paused user', async () => {
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([
        { user_id: 'user1', paused_at: new Date().toISOString() },
      ]);

      const result = await service.getUserHostingStatus('user1');

      expect(result).toEqual({ userId: 'user1', isPaused: true });
    });

    it('should return correct hosting status for non-paused user', async () => {
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([]);

      const result = await service.getUserHostingStatus('user2');

      expect(result).toEqual({ userId: 'user2', isPaused: false });
    });
  });

  // ==================== pauseUser ====================

  describe('pauseUser', () => {
    it('should add user to memory cache and persist to DB', async () => {
      mockUserHostingRepository.upsertPause.mockResolvedValue(undefined);

      await service.pauseUser('user1');

      // Should be in memory cache
      const entry = (service as any).pausedUsersCache.get('user1');
      expect(entry).toBeDefined();
      expect(entry.isPaused).toBe(true);
      expect(entry.pausedAt).toBeLessThanOrEqual(Date.now());

      expect(mockUserHostingRepository.upsertPause).toHaveBeenCalledWith('user1', {
        pausedAt: expect.any(String),
        pauseExpiresAt: expect.any(String),
        isPermanent: false,
        reason: undefined,
        operator: undefined,
        source: undefined,
      });
    });

    it('should persist permanent pause with null expiry, reason and audit fields', async () => {
      mockUserHostingRepository.upsertPause.mockResolvedValue(undefined);

      await service.pauseUser('user1', {
        permanent: true,
        reason: '店长微信',
        operator: 'ops-a',
        source: 'manual',
      });

      const entry = (service as any).pausedUsersCache.get('user1');
      expect(entry.permanent).toBe(true);
      expect(entry.reason).toBe('店长微信');
      expect(entry.operator).toBe('ops-a');
      expect(entry.source).toBe('manual');

      expect(mockUserHostingRepository.upsertPause).toHaveBeenCalledWith('user1', {
        pausedAt: expect.any(String),
        pauseExpiresAt: null,
        isPermanent: true,
        reason: '店长微信',
        operator: 'ops-a',
        source: 'manual',
      });

      // 永久暂停立即生效且不会因解禁期限失效
      await expect(service.isUserPaused('user1')).resolves.toBe(true);
    });

    it('should handle DB failure gracefully without affecting memory cache', async () => {
      mockUserHostingRepository.upsertPause.mockRejectedValue(new Error('DB error'));

      await expect(service.pauseUser('user1')).resolves.not.toThrow();

      // Memory cache should still be updated
      const entry = (service as any).pausedUsersCache.get('user1');
      expect(entry).toBeDefined();
      expect(entry.isPaused).toBe(true);
    });
  });

  // ==================== resumeUser ====================

  describe('resumeUser', () => {
    it('should remove user from memory cache and update DB', async () => {
      // Pre-populate cache
      (service as any).pausedUsersCache.set('user1', { isPaused: true, pausedAt: Date.now() });
      mockUserHostingRepository.updateResume.mockResolvedValue(undefined);

      await service.resumeUser('user1');

      expect((service as any).pausedUsersCache.has('user1')).toBe(false);
      expect(mockUserHostingRepository.updateResume).toHaveBeenCalledWith('user1');
    });

    it('should handle DB failure gracefully', async () => {
      (service as any).pausedUsersCache.set('user1', { isPaused: true, pausedAt: Date.now() });
      mockUserHostingRepository.updateResume.mockRejectedValue(new Error('DB error'));

      await expect(service.resumeUser('user1')).resolves.not.toThrow();

      // Memory cache should still be updated
      expect((service as any).pausedUsersCache.has('user1')).toBe(false);
    });

    it('should work even when user is not in cache', async () => {
      mockUserHostingRepository.updateResume.mockResolvedValue(undefined);

      await expect(service.resumeUser('nonexistent')).resolves.not.toThrow();

      expect(mockUserHostingRepository.updateResume).toHaveBeenCalledWith('nonexistent');
    });
  });

  // ==================== getPausedUsersWithProfiles ====================

  describe('getPausedUsersWithProfiles', () => {
    it('should return empty array when no users are paused', async () => {
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([]);

      const result = await service.getPausedUsersWithProfiles();

      expect(result).toEqual([]);
      expect(mockUserHostingRepository.findUserProfiles).not.toHaveBeenCalled();
    });

    it('should return paused users with profiles merged', async () => {
      const futureIso = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([
        {
          user_id: 'user1',
          paused_at: new Date().toISOString(),
          pause_expires_at: futureIso,
        },
        {
          user_id: 'user2',
          paused_at: new Date().toISOString(),
          pause_expires_at: futureIso,
        },
      ]);
      mockUserHostingRepository.findUserProfiles.mockResolvedValue([
        { chatId: 'user1', odName: 'Alice', groupName: 'GroupA', botUserId: 'bot-a' },
        { chatId: 'user2', odName: 'Bob', groupName: 'GroupB' },
      ]);

      const result = await service.getPausedUsersWithProfiles();

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.userId).sort()).toEqual(['user1', 'user2']);
      const user1 = result.find((r) => r.userId === 'user1');
      const user2 = result.find((r) => r.userId === 'user2');
      expect(user1).toMatchObject({ odName: 'Alice', groupName: 'GroupA', botUserId: 'bot-a' });
      expect(user2).toMatchObject({ odName: 'Bob', groupName: 'GroupB' });
    });

    it('should return paused users without profiles when profile query fails', async () => {
      const futureIso = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([
        {
          user_id: 'user1',
          paused_at: new Date().toISOString(),
          pause_expires_at: futureIso,
        },
      ]);
      mockUserHostingRepository.findUserProfiles.mockRejectedValue(new Error('DB error'));

      const result = await service.getPausedUsersWithProfiles();

      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe('user1');
      expect(result[0].odName).toBeUndefined();
    });

    it('should use cached data when cache is valid', async () => {
      const now = Date.now();
      (service as any).pausedUsersCache.set('user1', {
        isPaused: true,
        pausedAt: now,
        expiresAt: now + 3 * 24 * 60 * 60 * 1000,
      });
      (service as any).cacheExpiry = now + 60_000;

      mockUserHostingRepository.findUserProfiles.mockResolvedValue([
        { chatId: 'user1', odName: 'Alice', groupName: 'GroupA' },
      ]);

      const result = await service.getPausedUsersWithProfiles();

      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe('user1');
      expect(mockUserHostingRepository.findPausedUserIds).not.toHaveBeenCalled();
    });

    it('should expose isPermanent and pauseReason with null expiry for permanent pauses', async () => {
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([
        {
          user_id: 'user1',
          paused_at: new Date().toISOString(),
          pause_expires_at: null,
          is_permanent: true,
          pause_reason: '候选人黑名单：恶意刷岗',
        },
      ]);
      mockUserHostingRepository.findUserProfiles.mockResolvedValue([]);

      const result = await service.getPausedUsersWithProfiles();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        userId: 'user1',
        isPermanent: true,
        pauseReason: '候选人黑名单：恶意刷岗',
        pauseExpiresAt: null,
      });
    });

    it('should handle missing profile for some users gracefully', async () => {
      const futureIso = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([
        {
          user_id: 'user1',
          paused_at: new Date().toISOString(),
          pause_expires_at: futureIso,
        },
        {
          user_id: 'user2',
          paused_at: new Date().toISOString(),
          pause_expires_at: futureIso,
        },
      ]);
      // Only user1 has a profile
      mockUserHostingRepository.findUserProfiles.mockResolvedValue([
        { chatId: 'user1', odName: 'Alice', groupName: 'GroupA' },
      ]);

      const result = await service.getPausedUsersWithProfiles();

      const user2 = result.find((r) => r.userId === 'user2');
      expect(user2?.odName).toBeUndefined();
      expect(user2?.groupName).toBeUndefined();
    });
  });

  // ==================== refreshCache ====================

  describe('refreshCache', () => {
    it('should reset cache expiry and reload from DB', async () => {
      (service as any).cacheExpiry = Date.now() + 60_000;
      (service as any).pausedUsersCache.set('user1', { isPaused: true, pausedAt: Date.now() });

      mockUserHostingRepository.findPausedUserIds.mockResolvedValue([]);

      await service.refreshCache();

      expect(mockUserHostingRepository.findPausedUserIds).toHaveBeenCalledTimes(1);
      expect((service as any).pausedUsersCache.size).toBe(0);
    });
  });
});

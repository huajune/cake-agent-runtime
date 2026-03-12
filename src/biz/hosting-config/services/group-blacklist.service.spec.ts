import { Test, TestingModule } from '@nestjs/testing';
import { GroupBlacklistService } from './group-blacklist.service';
import { RedisService } from '@core/redis';
import { GroupBlacklistRepository } from '../repositories/group-blacklist.repository';
import { GroupBlacklistItem } from '../entities/group-blacklist.entity';

describe('GroupBlacklistService', () => {
  let service: GroupBlacklistService;

  const mockRedisService = {
    get: jest.fn(),
    setex: jest.fn(),
  };

  const mockGroupBlacklistRepository = {
    loadBlacklistFromDb: jest.fn(),
    saveBlacklistToDb: jest.fn(),
  };

  const sampleBlacklistItems: GroupBlacklistItem[] = [
    { group_id: 'group1', reason: 'spam', added_at: 1000000 },
    { group_id: 'group2', reason: 'test', added_at: 2000000 },
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupBlacklistService,
        { provide: RedisService, useValue: mockRedisService },
        { provide: GroupBlacklistRepository, useValue: mockGroupBlacklistRepository },
      ],
    }).compile();

    service = module.get<GroupBlacklistService>(GroupBlacklistService);

    jest.clearAllMocks();

    // Force cache to expire so tests start fresh
    (service as any).memoryCacheExpiry = 0;
    (service as any).memoryCache.clear();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== isGroupBlacklisted ====================

  describe('isGroupBlacklisted', () => {
    it('should return false for empty groupId', async () => {
      const result = await service.isGroupBlacklisted('');
      expect(result).toBe(false);
      expect(mockRedisService.get).not.toHaveBeenCalled();
    });

    it('should return true when group is in blacklist (from Redis)', async () => {
      mockRedisService.get.mockResolvedValue(sampleBlacklistItems);

      const result = await service.isGroupBlacklisted('group1');

      expect(result).toBe(true);
    });

    it('should return false when group is not in blacklist (from Redis)', async () => {
      mockRedisService.get.mockResolvedValue(sampleBlacklistItems);

      const result = await service.isGroupBlacklisted('unknown-group');

      expect(result).toBe(false);
    });

    it('should load from DB when Redis returns null', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockResolvedValue(sampleBlacklistItems);
      mockRedisService.setex.mockResolvedValue(undefined);

      const result = await service.isGroupBlacklisted('group1');

      expect(result).toBe(true);
      expect(mockGroupBlacklistRepository.loadBlacklistFromDb).toHaveBeenCalledTimes(1);
    });

    it('should use memory cache when cache is not expired', async () => {
      // Pre-warm the cache
      mockRedisService.get.mockResolvedValue(sampleBlacklistItems);
      await service.isGroupBlacklisted('group1');

      // Memory cache should be set now - reset mocks and call again
      jest.clearAllMocks();
      const result = await service.isGroupBlacklisted('group1');

      expect(result).toBe(true);
      // Redis should not be called again since memory cache is valid
      expect(mockRedisService.get).not.toHaveBeenCalled();
    });

    it('should return false and set backoff expiry when DB load fails', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockRejectedValue(
        new Error('DB connection error'),
      );

      const result = await service.isGroupBlacklisted('group1');

      expect(result).toBe(false);
      // Should set backoff expiry (~30 seconds from now)
      const expiry = (service as any).memoryCacheExpiry;
      expect(expiry).toBeGreaterThan(Date.now());
      expect(expiry).toBeLessThanOrEqual(Date.now() + 30_000 + 100);
    });
  });

  // ==================== getGroupBlacklist ====================

  describe('getGroupBlacklist', () => {
    it('should return all blacklist items from Redis', async () => {
      mockRedisService.get.mockResolvedValue(sampleBlacklistItems);

      const result = await service.getGroupBlacklist();

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.group_id)).toContain('group1');
      expect(result.map((i) => i.group_id)).toContain('group2');
    });

    it('should return empty array when blacklist is empty', async () => {
      mockRedisService.get.mockResolvedValue([]);

      const result = await service.getGroupBlacklist();

      expect(result).toEqual([]);
    });

    it('should load from DB when Redis returns null array', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockResolvedValue(sampleBlacklistItems);
      mockRedisService.setex.mockResolvedValue(undefined);

      const result = await service.getGroupBlacklist();

      expect(result).toHaveLength(2);
      expect(mockGroupBlacklistRepository.loadBlacklistFromDb).toHaveBeenCalledTimes(1);
      // Should backfill Redis
      expect(mockRedisService.setex).toHaveBeenCalledWith(
        'config:group_blacklist',
        300,
        expect.any(Array),
      );
    });
  });

  // ==================== addGroupToBlacklist ====================

  describe('addGroupToBlacklist', () => {
    beforeEach(() => {
      mockRedisService.setex.mockResolvedValue(undefined);
      mockGroupBlacklistRepository.saveBlacklistToDb.mockResolvedValue(undefined);
    });

    it('should add group to blacklist with reason', async () => {
      await service.addGroupToBlacklist('newGroup', 'spam');

      // Verify the item is in memory cache
      expect((service as any).memoryCache.has('newGroup')).toBe(true);
      const item = (service as any).memoryCache.get('newGroup') as GroupBlacklistItem;
      expect(item.group_id).toBe('newGroup');
      expect(item.reason).toBe('spam');
    });

    it('should add group to blacklist without reason', async () => {
      await service.addGroupToBlacklist('newGroup');

      const item = (service as any).memoryCache.get('newGroup') as GroupBlacklistItem;
      expect(item.group_id).toBe('newGroup');
      expect(item.reason).toBeUndefined();
    });

    it('should persist to Redis and DB', async () => {
      await service.addGroupToBlacklist('newGroup', 'reason');

      expect(mockRedisService.setex).toHaveBeenCalledWith(
        'config:group_blacklist',
        300,
        expect.arrayContaining([
          expect.objectContaining({ group_id: 'newGroup', reason: 'reason' }),
        ]),
      );
      expect(mockGroupBlacklistRepository.saveBlacklistToDb).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ group_id: 'newGroup', reason: 'reason' }),
        ]),
      );
    });

    it('should handle DB save failure gracefully', async () => {
      mockGroupBlacklistRepository.saveBlacklistToDb.mockRejectedValue(new Error('DB save error'));

      // Should not throw
      await expect(service.addGroupToBlacklist('newGroup')).resolves.not.toThrow();

      // Item should still be in memory and Redis
      expect((service as any).memoryCache.has('newGroup')).toBe(true);
    });
  });

  // ==================== removeGroupFromBlacklist ====================

  describe('removeGroupFromBlacklist', () => {
    beforeEach(() => {
      // Pre-populate the cache
      (service as any).memoryCache.set('group1', sampleBlacklistItems[0]);
      (service as any).memoryCache.set('group2', sampleBlacklistItems[1]);
      (service as any).memoryCacheExpiry = Date.now() + 300_000;
      mockRedisService.setex.mockResolvedValue(undefined);
      mockGroupBlacklistRepository.saveBlacklistToDb.mockResolvedValue(undefined);
    });

    it('should remove group from blacklist and return true', async () => {
      const result = await service.removeGroupFromBlacklist('group1');

      expect(result).toBe(true);
      expect((service as any).memoryCache.has('group1')).toBe(false);
    });

    it('should return false when group is not in blacklist', async () => {
      const result = await service.removeGroupFromBlacklist('nonexistent');

      expect(result).toBe(false);
    });

    it('should persist changes to Redis and DB after removal', async () => {
      await service.removeGroupFromBlacklist('group1');

      expect(mockRedisService.setex).toHaveBeenCalledWith(
        'config:group_blacklist',
        300,
        expect.not.arrayContaining([expect.objectContaining({ group_id: 'group1' })]),
      );
      expect(mockGroupBlacklistRepository.saveBlacklistToDb).toHaveBeenCalled();
    });

    it('should handle DB save failure gracefully when removing', async () => {
      mockGroupBlacklistRepository.saveBlacklistToDb.mockRejectedValue(new Error('DB save error'));

      await expect(service.removeGroupFromBlacklist('group1')).resolves.toBe(true);

      // Memory cache should still be updated
      expect((service as any).memoryCache.has('group1')).toBe(false);
    });
  });

  // ==================== refreshCache ====================

  describe('refreshCache', () => {
    it('should clear memory cache and reload from DB', async () => {
      // Pre-populate cache
      (service as any).memoryCacheExpiry = Date.now() + 300_000;
      (service as any).memoryCache.set('group1', sampleBlacklistItems[0]);

      mockRedisService.get.mockResolvedValue(null);
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockResolvedValue([]);
      mockRedisService.setex.mockResolvedValue(undefined);

      await service.refreshCache();

      // After refresh, memoryCacheExpiry should be 0 then reloaded
      expect(mockGroupBlacklistRepository.loadBlacklistFromDb).toHaveBeenCalled();
    });
  });

  // ==================== loadGroupBlacklist ====================

  describe('loadGroupBlacklist', () => {
    it('should load from Redis (L2) if available', async () => {
      mockRedisService.get.mockResolvedValue(sampleBlacklistItems);

      await service.loadGroupBlacklist();

      expect(mockRedisService.get).toHaveBeenCalledWith('config:group_blacklist');
      expect(mockGroupBlacklistRepository.loadBlacklistFromDb).not.toHaveBeenCalled();
      expect((service as any).memoryCache.size).toBe(2);
    });

    it('should fall back to DB (L3) when Redis returns null', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockResolvedValue(sampleBlacklistItems);
      mockRedisService.setex.mockResolvedValue(undefined);

      await service.loadGroupBlacklist();

      expect(mockGroupBlacklistRepository.loadBlacklistFromDb).toHaveBeenCalledTimes(1);
      expect((service as any).memoryCache.size).toBe(2);
      // Should backfill Redis
      expect(mockRedisService.setex).toHaveBeenCalledWith(
        'config:group_blacklist',
        300,
        sampleBlacklistItems,
      );
    });

    it('should handle empty Redis response (not an array)', async () => {
      mockRedisService.get.mockResolvedValue('not-an-array');
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockResolvedValue([]);
      mockRedisService.setex.mockResolvedValue(undefined);

      await service.loadGroupBlacklist();

      expect(mockGroupBlacklistRepository.loadBlacklistFromDb).toHaveBeenCalled();
    });
  });
});

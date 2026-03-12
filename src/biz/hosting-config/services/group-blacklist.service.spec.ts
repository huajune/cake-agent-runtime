import { Test, TestingModule } from '@nestjs/testing';
import { GroupBlacklistService } from './group-blacklist.service';
import { GroupBlacklistRepository } from '../repositories/group-blacklist.repository';
import { GroupBlacklistItem } from '../entities/group-blacklist.entity';

describe('GroupBlacklistService', () => {
  let service: GroupBlacklistService;

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
      expect(mockGroupBlacklistRepository.loadBlacklistFromDb).not.toHaveBeenCalled();
    });

    it('should return true when group is in blacklist (loaded from DB)', async () => {
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockResolvedValue(sampleBlacklistItems);

      const result = await service.isGroupBlacklisted('group1');

      expect(result).toBe(true);
      expect(mockGroupBlacklistRepository.loadBlacklistFromDb).toHaveBeenCalledTimes(1);
    });

    it('should return false when group is not in blacklist', async () => {
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockResolvedValue(sampleBlacklistItems);

      const result = await service.isGroupBlacklisted('unknown-group');

      expect(result).toBe(false);
    });

    it('should use memory cache when cache is not expired', async () => {
      // Pre-warm the cache
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockResolvedValue(sampleBlacklistItems);
      await service.isGroupBlacklisted('group1');

      // Memory cache should be set now - reset mocks and call again
      jest.clearAllMocks();
      const result = await service.isGroupBlacklisted('group1');

      expect(result).toBe(true);
      // DB should not be called again since memory cache is valid
      expect(mockGroupBlacklistRepository.loadBlacklistFromDb).not.toHaveBeenCalled();
    });

    it('should return false and set backoff expiry when DB load fails', async () => {
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
    it('should return all blacklist items loaded from DB', async () => {
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockResolvedValue(sampleBlacklistItems);

      const result = await service.getGroupBlacklist();

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.group_id)).toContain('group1');
      expect(result.map((i) => i.group_id)).toContain('group2');
    });

    it('should return empty array when blacklist is empty', async () => {
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockResolvedValue([]);

      const result = await service.getGroupBlacklist();

      expect(result).toEqual([]);
    });

    it('should use memory cache when cache is valid', async () => {
      // Pre-populate cache
      (service as any).memoryCache.set('group1', sampleBlacklistItems[0]);
      (service as any).memoryCacheExpiry = Date.now() + 300_000;

      const result = await service.getGroupBlacklist();

      expect(result).toHaveLength(1);
      expect(mockGroupBlacklistRepository.loadBlacklistFromDb).not.toHaveBeenCalled();
    });
  });

  // ==================== addGroupToBlacklist ====================

  describe('addGroupToBlacklist', () => {
    beforeEach(() => {
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

    it('should persist to DB', async () => {
      await service.addGroupToBlacklist('newGroup', 'reason');

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

      // Item should still be in memory
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

    it('should persist changes to DB after removal', async () => {
      await service.removeGroupFromBlacklist('group1');

      expect(mockGroupBlacklistRepository.saveBlacklistToDb).toHaveBeenCalledWith(
        expect.not.arrayContaining([expect.objectContaining({ group_id: 'group1' })]),
      );
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

      mockGroupBlacklistRepository.loadBlacklistFromDb.mockResolvedValue([]);

      await service.refreshCache();

      // After refresh, DB should have been called
      expect(mockGroupBlacklistRepository.loadBlacklistFromDb).toHaveBeenCalled();
    });
  });

  // ==================== loadGroupBlacklist ====================

  describe('loadGroupBlacklist', () => {
    it('should load from DB and populate memory cache', async () => {
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockResolvedValue(sampleBlacklistItems);

      await service.loadGroupBlacklist();

      expect(mockGroupBlacklistRepository.loadBlacklistFromDb).toHaveBeenCalledTimes(1);
      expect((service as any).memoryCache.size).toBe(2);
    });

    it('should handle empty DB response', async () => {
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockResolvedValue([]);

      await service.loadGroupBlacklist();

      expect((service as any).memoryCache.size).toBe(0);
    });

    it('should set backoff expiry on DB error', async () => {
      mockGroupBlacklistRepository.loadBlacklistFromDb.mockRejectedValue(new Error('DB error'));

      await service.loadGroupBlacklist();

      const expiry = (service as any).memoryCacheExpiry;
      expect(expiry).toBeGreaterThan(Date.now());
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { CandidateBlacklistService } from '@biz/hosting-config/services/candidate-blacklist.service';
import { CandidateBlacklistRepository } from '@biz/hosting-config/repositories/candidate-blacklist.repository';
import { CandidateBlacklistItem } from '@biz/hosting-config/entities/candidate-blacklist.entity';
import { RedisService } from '@infra/redis/redis.service';

describe('CandidateBlacklistService', () => {
  let service: CandidateBlacklistService;

  const mockCandidateBlacklistRepository = {
    loadBlacklistFromDb: jest.fn(),
    saveBlacklistToDb: jest.fn(),
  };

  const mockRedisService = {
    get: jest.fn(),
    set: jest.fn(),
  };

  const sampleBlacklistItems: CandidateBlacklistItem[] = [
    { target_id: 'contact-1', reason: '恶意刷岗', operator: '小王', added_at: 1000000 },
    { target_id: 'chat-2', reason: '辱骂客服', added_at: 2000000 },
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidateBlacklistService,
        { provide: CandidateBlacklistRepository, useValue: mockCandidateBlacklistRepository },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get<CandidateBlacklistService>(CandidateBlacklistService);

    jest.clearAllMocks();
    mockRedisService.get.mockResolvedValue(null);
    mockRedisService.set.mockResolvedValue(undefined);

    // Force cache to expire so tests start fresh
    (service as any).memoryCacheExpiry = 0;
    (service as any).memoryCache.clear();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== matchBlacklisted ====================

  describe('matchBlacklisted', () => {
    it('should return the hit item when any id matches', async () => {
      mockCandidateBlacklistRepository.loadBlacklistFromDb.mockResolvedValue(sampleBlacklistItems);

      const result = await service.matchBlacklisted(['chat-x', 'contact-1', undefined]);

      expect(result).toMatchObject({ target_id: 'contact-1', reason: '恶意刷岗' });
    });

    it('should return null when no id matches', async () => {
      mockCandidateBlacklistRepository.loadBlacklistFromDb.mockResolvedValue(sampleBlacklistItems);

      const result = await service.matchBlacklisted(['chat-x', 'contact-x']);

      expect(result).toBeNull();
    });

    it('should skip null/undefined ids', async () => {
      mockCandidateBlacklistRepository.loadBlacklistFromDb.mockResolvedValue(sampleBlacklistItems);

      const result = await service.matchBlacklisted([null, undefined]);

      expect(result).toBeNull();
    });

    it('should use memory cache when cache is not expired', async () => {
      mockCandidateBlacklistRepository.loadBlacklistFromDb.mockResolvedValue(sampleBlacklistItems);
      await service.matchBlacklisted(['contact-1']);

      jest.clearAllMocks();
      const result = await service.matchBlacklisted(['contact-1']);

      expect(result).not.toBeNull();
      expect(mockCandidateBlacklistRepository.loadBlacklistFromDb).not.toHaveBeenCalled();
    });

    it('should return null and set backoff expiry when DB load fails', async () => {
      mockCandidateBlacklistRepository.loadBlacklistFromDb.mockRejectedValue(
        new Error('DB connection error'),
      );

      const result = await service.matchBlacklisted(['contact-1']);

      expect(result).toBeNull();
      const expiry = (service as any).memoryCacheExpiry;
      expect(expiry).toBeGreaterThan(Date.now());
      expect(expiry).toBeLessThanOrEqual(Date.now() + 30_000 + 100);
    });

    it('should hydrate from Redis shared cache before falling back to DB', async () => {
      mockRedisService.get.mockResolvedValue({ items: sampleBlacklistItems });

      const result = await service.matchBlacklisted(['chat-2']);

      expect(result).toMatchObject({ target_id: 'chat-2', reason: '辱骂客服' });
      expect(mockCandidateBlacklistRepository.loadBlacklistFromDb).not.toHaveBeenCalled();
    });
  });

  // ==================== getCandidateBlacklist ====================

  describe('getCandidateBlacklist', () => {
    it('should return all blacklist items loaded from DB', async () => {
      mockCandidateBlacklistRepository.loadBlacklistFromDb.mockResolvedValue(sampleBlacklistItems);

      const result = await service.getCandidateBlacklist();

      expect(result).toHaveLength(2);
      expect(result.map((i) => i.target_id)).toContain('contact-1');
      expect(result.map((i) => i.target_id)).toContain('chat-2');
    });

    it('should return empty array when blacklist is empty', async () => {
      mockCandidateBlacklistRepository.loadBlacklistFromDb.mockResolvedValue([]);

      const result = await service.getCandidateBlacklist();

      expect(result).toEqual([]);
    });
  });

  // ==================== addCandidateToBlacklist ====================

  describe('addCandidateToBlacklist', () => {
    beforeEach(() => {
      mockCandidateBlacklistRepository.saveBlacklistToDb.mockResolvedValue(undefined);
    });

    it('should add candidate with reason and operator', async () => {
      await service.addCandidateToBlacklist('contact-new', '恶意刷岗', '小王');

      const item = (service as any).memoryCache.get('contact-new') as CandidateBlacklistItem;
      expect(item.target_id).toBe('contact-new');
      expect(item.reason).toBe('恶意刷岗');
      expect(item.operator).toBe('小王');
    });

    it('should persist to DB', async () => {
      await service.addCandidateToBlacklist('contact-new', '恶意刷岗');

      expect(mockCandidateBlacklistRepository.saveBlacklistToDb).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ target_id: 'contact-new', reason: '恶意刷岗' }),
        ]),
      );
    });

    it('should handle DB save failure gracefully', async () => {
      mockCandidateBlacklistRepository.saveBlacklistToDb.mockRejectedValue(
        new Error('DB save error'),
      );

      await expect(service.addCandidateToBlacklist('contact-new', '理由')).resolves.not.toThrow();
      expect((service as any).memoryCache.has('contact-new')).toBe(true);
    });
  });

  // ==================== removeCandidateFromBlacklist ====================

  describe('removeCandidateFromBlacklist', () => {
    beforeEach(() => {
      (service as any).memoryCache.set('contact-1', sampleBlacklistItems[0]);
      (service as any).memoryCache.set('chat-2', sampleBlacklistItems[1]);
      (service as any).memoryCacheExpiry = Date.now() + 300_000;
      mockCandidateBlacklistRepository.saveBlacklistToDb.mockResolvedValue(undefined);
    });

    it('should remove candidate and return true', async () => {
      const result = await service.removeCandidateFromBlacklist('contact-1');

      expect(result).toBe(true);
      expect((service as any).memoryCache.has('contact-1')).toBe(false);
    });

    it('should return false when candidate is not in blacklist', async () => {
      const result = await service.removeCandidateFromBlacklist('nonexistent');

      expect(result).toBe(false);
    });

    it('should persist changes to DB after removal', async () => {
      await service.removeCandidateFromBlacklist('contact-1');

      expect(mockCandidateBlacklistRepository.saveBlacklistToDb).toHaveBeenCalledWith(
        expect.not.arrayContaining([expect.objectContaining({ target_id: 'contact-1' })]),
      );
    });
  });

  // ==================== refreshCache ====================

  describe('refreshCache', () => {
    it('should clear memory cache and reload from DB', async () => {
      (service as any).memoryCacheExpiry = Date.now() + 300_000;
      (service as any).memoryCache.set('contact-1', sampleBlacklistItems[0]);

      mockCandidateBlacklistRepository.loadBlacklistFromDb.mockResolvedValue([]);

      await service.refreshCache();

      expect(mockCandidateBlacklistRepository.loadBlacklistFromDb).toHaveBeenCalled();
      expect((service as any).memoryCache.size).toBe(0);
    });
  });
});

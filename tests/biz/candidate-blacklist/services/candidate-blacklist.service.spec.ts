import { Test, TestingModule } from '@nestjs/testing';
import { CandidateBlacklistService } from '@biz/candidate-blacklist/services/candidate-blacklist.service';
import { CandidateBlacklistRepository } from '@biz/candidate-blacklist/repositories/candidate-blacklist.repository';
import { CandidateBlacklistRecord } from '@biz/candidate-blacklist/entities/candidate-blacklist.entity';
import { RedisService } from '@infra/redis/redis.service';

function makeRecord(partial: Partial<CandidateBlacklistRecord>): CandidateBlacklistRecord {
  return {
    id: 'id-1',
    target_id: 'contact-1',
    reason: '恶意刷岗',
    operator: null,
    chat_id: null,
    im_contact_id: null,
    contact_name: null,
    source: 'manual',
    hit_count: 0,
    last_hit_at: null,
    last_hit_chat_id: null,
    last_hit_bot_id: null,
    last_hit_message_id: null,
    created_at: '2026-06-11T10:00:00Z',
    updated_at: '2026-06-11T10:00:00Z',
    ...partial,
  };
}

describe('CandidateBlacklistService', () => {
  let service: CandidateBlacklistService;

  const mockRepository = {
    findAll: jest.fn(),
    upsertItem: jest.fn(),
    deleteByTargetId: jest.fn(),
    recordHit: jest.fn(),
  };

  const mockRedisService = {
    get: jest.fn(),
    set: jest.fn(),
  };

  const sampleRecords: CandidateBlacklistRecord[] = [
    makeRecord({ id: 'id-1', target_id: 'contact-1', reason: '恶意刷岗', operator: '小王' }),
    makeRecord({ id: 'id-2', target_id: 'chat-2', reason: '辱骂客服' }),
  ];

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandidateBlacklistService,
        { provide: CandidateBlacklistRepository, useValue: mockRepository },
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
    it('should return the hit record when any id matches', async () => {
      mockRepository.findAll.mockResolvedValue(sampleRecords);

      const result = await service.matchBlacklisted(['chat-x', 'contact-1', undefined]);

      expect(result).toMatchObject({ target_id: 'contact-1', reason: '恶意刷岗' });
    });

    it('should return null when no id matches', async () => {
      mockRepository.findAll.mockResolvedValue(sampleRecords);

      const result = await service.matchBlacklisted(['chat-x', 'contact-x']);

      expect(result).toBeNull();
    });

    it('should skip null/undefined ids', async () => {
      mockRepository.findAll.mockResolvedValue(sampleRecords);

      const result = await service.matchBlacklisted([null, undefined]);

      expect(result).toBeNull();
    });

    it('should use memory cache when cache is not expired', async () => {
      mockRepository.findAll.mockResolvedValue(sampleRecords);
      await service.matchBlacklisted(['contact-1']);

      jest.clearAllMocks();
      const result = await service.matchBlacklisted(['contact-1']);

      expect(result).not.toBeNull();
      expect(mockRepository.findAll).not.toHaveBeenCalled();
    });

    it('should return null and set backoff expiry when DB load fails', async () => {
      mockRepository.findAll.mockRejectedValue(new Error('DB connection error'));

      const result = await service.matchBlacklisted(['contact-1']);

      expect(result).toBeNull();
      const expiry = (service as any).memoryCacheExpiry;
      expect(expiry).toBeGreaterThan(Date.now());
      expect(expiry).toBeLessThanOrEqual(Date.now() + 30_000 + 100);
    });

    it('should hydrate from Redis shared cache before falling back to DB', async () => {
      mockRedisService.get.mockResolvedValue({ items: sampleRecords });

      const result = await service.matchBlacklisted(['chat-2']);

      expect(result).toMatchObject({ target_id: 'chat-2', reason: '辱骂客服' });
      expect(mockRepository.findAll).not.toHaveBeenCalled();
    });
  });

  // ==================== getCandidateBlacklist ====================

  describe('getCandidateBlacklist', () => {
    it('should always read from DB so hit-trace fields are fresh', async () => {
      // 预热缓存
      mockRepository.findAll.mockResolvedValue(sampleRecords);
      await service.matchBlacklisted(['contact-1']);
      jest.clearAllMocks();
      mockRepository.findAll.mockResolvedValue(sampleRecords);

      const result = await service.getCandidateBlacklist();

      expect(result).toHaveLength(2);
      expect(mockRepository.findAll).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when blacklist is empty', async () => {
      mockRepository.findAll.mockResolvedValue([]);

      const result = await service.getCandidateBlacklist();

      expect(result).toEqual([]);
    });
  });

  // ==================== addCandidateToBlacklist ====================

  describe('addCandidateToBlacklist', () => {
    it('should upsert record with audit snapshot and refresh cache', async () => {
      mockRepository.upsertItem.mockResolvedValue(undefined);
      mockRepository.findAll.mockResolvedValue([
        makeRecord({ target_id: 'contact-new', reason: '恶意刷岗', operator: '小王' }),
      ]);

      await service.addCandidateToBlacklist({
        targetId: 'contact-new',
        reason: '恶意刷岗',
        operator: '小王',
        chatId: 'chat-1',
        contactName: '张三',
      });

      expect(mockRepository.upsertItem).toHaveBeenCalledWith({
        targetId: 'contact-new',
        reason: '恶意刷岗',
        operator: '小王',
        chatId: 'chat-1',
        contactName: '张三',
      });
      // 写库后缓存被刷新，命中判定立即生效
      const hit = await service.matchBlacklisted(['contact-new']);
      expect(hit).not.toBeNull();
    });
  });

  // ==================== removeCandidateFromBlacklist ====================

  describe('removeCandidateFromBlacklist', () => {
    it('should delete record and return true', async () => {
      mockRepository.deleteByTargetId.mockResolvedValue(1);
      mockRepository.findAll.mockResolvedValue([]);

      const result = await service.removeCandidateFromBlacklist('contact-1');

      expect(result).toBe(true);
      expect(mockRepository.deleteByTargetId).toHaveBeenCalledWith('contact-1');
    });

    it('should return false when candidate is not in blacklist', async () => {
      mockRepository.deleteByTargetId.mockResolvedValue(0);
      mockRepository.findAll.mockResolvedValue([]);

      const result = await service.removeCandidateFromBlacklist('nonexistent');

      expect(result).toBe(false);
    });
  });

  // ==================== recordHit ====================

  describe('recordHit', () => {
    it('should delegate hit recording to repository', async () => {
      mockRepository.recordHit.mockResolvedValue(undefined);

      await service.recordHit('contact-1', {
        chatId: 'chat-9',
        botId: 'wxid-bot',
        messageId: 'msg-1',
      });

      expect(mockRepository.recordHit).toHaveBeenCalledWith('contact-1', {
        chatId: 'chat-9',
        botId: 'wxid-bot',
        messageId: 'msg-1',
      });
    });
  });

  // ==================== refreshCache ====================

  describe('refreshCache', () => {
    it('should clear memory cache and reload from DB', async () => {
      (service as any).memoryCacheExpiry = Date.now() + 300_000;
      (service as any).memoryCache.set('contact-1', sampleRecords[0]);

      mockRepository.findAll.mockResolvedValue([]);

      await service.refreshCache();

      expect(mockRepository.findAll).toHaveBeenCalled();
      expect((service as any).memoryCache.size).toBe(0);
    });
  });
});

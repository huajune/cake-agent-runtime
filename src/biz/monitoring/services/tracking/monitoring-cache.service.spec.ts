import { Test, TestingModule } from '@nestjs/testing';
import { MonitoringCacheService } from './monitoring-cache.service';
import { RedisService } from '@core/redis';

describe('MonitoringCacheService', () => {
  let service: MonitoringCacheService;
  let redisService: jest.Mocked<RedisService>;

  const mockPipeline = {
    hincrby: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([]),
  };

  const mockRedisClient = {
    hincrby: jest.fn(),
    hgetall: jest.fn(),
    hmset: jest.fn(),
    zadd: jest.fn(),
    zrange: jest.fn(),
    zcard: jest.fn(),
    incrby: jest.fn(),
    keys: jest.fn(),
    pipeline: jest.fn(() => mockPipeline),
  };

  const mockRedisService = {
    getClient: jest.fn(() => mockRedisClient),
    get: jest.fn(),
    set: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
    expire: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonitoringCacheService,
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<MonitoringCacheService>(MonitoringCacheService);
    redisService = module.get(RedisService);

    jest.clearAllMocks();
    mockRedisService.getClient.mockReturnValue(mockRedisClient);
    mockRedisClient.pipeline.mockReturnValue(mockPipeline);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========================================
  // incrementCounter
  // ========================================

  describe('incrementCounter', () => {
    it('should call hincrby with the correct key and field', async () => {
      mockRedisClient.hincrby.mockResolvedValue(1);

      await service.incrementCounter('totalMessages', 1);

      expect(mockRedisClient.hincrby).toHaveBeenCalledWith(
        'monitoring:counters',
        'totalMessages',
        1,
      );
    });

    it('should use default value of 1 when value is not provided', async () => {
      mockRedisClient.hincrby.mockResolvedValue(1);

      await service.incrementCounter('totalSuccess');

      expect(mockRedisClient.hincrby).toHaveBeenCalledWith(
        'monitoring:counters',
        'totalSuccess',
        1,
      );
    });

    it('should handle errors gracefully without throwing', async () => {
      mockRedisClient.hincrby.mockRejectedValue(new Error('Redis error'));

      await expect(service.incrementCounter('totalMessages', 1)).resolves.not.toThrow();
    });
  });

  // ========================================
  // incrementCounters
  // ========================================

  describe('incrementCounters', () => {
    it('should call pipeline hincrby for each numeric field', async () => {
      mockPipeline.exec.mockResolvedValue([]);

      await service.incrementCounters({ totalSuccess: 1, totalFallback: 1 });

      expect(mockRedisClient.pipeline).toHaveBeenCalled();
      expect(mockPipeline.hincrby).toHaveBeenCalledWith('monitoring:counters', 'totalSuccess', 1);
      expect(mockPipeline.hincrby).toHaveBeenCalledWith('monitoring:counters', 'totalFallback', 1);
      expect(mockPipeline.exec).toHaveBeenCalled();
    });

    it('should handle errors gracefully without throwing', async () => {
      mockRedisClient.pipeline.mockReturnValue({
        hincrby: jest.fn().mockReturnThis(),
        exec: jest.fn().mockRejectedValue(new Error('Pipeline error')),
      });

      await expect(service.incrementCounters({ totalSuccess: 1 })).resolves.not.toThrow();
    });
  });

  // ========================================
  // getCounters
  // ========================================

  describe('getCounters', () => {
    it('should return parsed counters from Redis hash', async () => {
      mockRedisClient.hgetall.mockResolvedValue({
        totalMessages: '10',
        totalSuccess: '8',
        totalFailure: '2',
        totalAiDuration: '5000',
        totalSendDuration: '3000',
        totalFallback: '1',
        totalFallbackSuccess: '1',
      });

      const result = await service.getCounters();

      expect(result).toEqual({
        totalMessages: 10,
        totalSuccess: 8,
        totalFailure: 2,
        totalAiDuration: 5000,
        totalSendDuration: 3000,
        totalFallback: 1,
        totalFallbackSuccess: 1,
      });
    });

    it('should return default counters when Redis returns null', async () => {
      mockRedisClient.hgetall.mockResolvedValue(null);

      const result = await service.getCounters();

      expect(result).toEqual({
        totalMessages: 0,
        totalSuccess: 0,
        totalFailure: 0,
        totalAiDuration: 0,
        totalSendDuration: 0,
        totalFallback: 0,
        totalFallbackSuccess: 0,
      });
    });

    it('should return default counters when Redis throws an error', async () => {
      mockRedisClient.hgetall.mockRejectedValue(new Error('Redis error'));

      const result = await service.getCounters();

      expect(result).toEqual({
        totalMessages: 0,
        totalSuccess: 0,
        totalFailure: 0,
        totalAiDuration: 0,
        totalSendDuration: 0,
        totalFallback: 0,
        totalFallbackSuccess: 0,
      });
    });

    it('should use 0 as default for missing fields', async () => {
      mockRedisClient.hgetall.mockResolvedValue({ totalMessages: '5' });

      const result = await service.getCounters();

      expect(result.totalMessages).toBe(5);
      expect(result.totalSuccess).toBe(0);
      expect(result.totalFailure).toBe(0);
    });
  });

  // ========================================
  // resetCounters
  // ========================================

  describe('resetCounters', () => {
    it('should delete the counters key from Redis', async () => {
      mockRedisService.del.mockResolvedValue(1);

      await service.resetCounters();

      expect(redisService.del).toHaveBeenCalledWith('monitoring:counters');
    });

    it('should handle errors gracefully without throwing', async () => {
      mockRedisService.del.mockRejectedValue(new Error('Redis error'));

      await expect(service.resetCounters()).resolves.not.toThrow();
    });
  });

  // ========================================
  // setCounters
  // ========================================

  describe('setCounters', () => {
    it('should call hmset with stringified counter values', async () => {
      mockRedisClient.hmset.mockResolvedValue('OK');

      const counters = {
        totalMessages: 100,
        totalSuccess: 90,
        totalFailure: 10,
        totalAiDuration: 50000,
        totalSendDuration: 30000,
        totalFallback: 5,
        totalFallbackSuccess: 4,
      };

      await service.setCounters(counters);

      expect(mockRedisClient.hmset).toHaveBeenCalledWith('monitoring:counters', {
        totalMessages: '100',
        totalSuccess: '90',
        totalFailure: '10',
        totalAiDuration: '50000',
        totalSendDuration: '30000',
        totalFallback: '5',
        totalFallbackSuccess: '4',
      });
    });

    it('should handle errors gracefully without throwing', async () => {
      mockRedisClient.hmset.mockRejectedValue(new Error('Redis error'));

      await expect(
        service.setCounters({
          totalMessages: 0,
          totalSuccess: 0,
          totalFailure: 0,
          totalAiDuration: 0,
          totalSendDuration: 0,
          totalFallback: 0,
          totalFallbackSuccess: 0,
        }),
      ).resolves.not.toThrow();
    });
  });

  // ========================================
  // addActiveUser
  // ========================================

  describe('addActiveUser', () => {
    it('should add user to sorted set with correct score and expire', async () => {
      mockRedisClient.zadd.mockResolvedValue(1);
      mockRedisService.expire.mockResolvedValue(1);
      const timestamp = Date.now();

      await service.addActiveUser('user-1', timestamp, '2026-03-11');

      expect(mockRedisClient.zadd).toHaveBeenCalledWith('monitoring:active_users:2026-03-11', {
        score: timestamp,
        member: 'user-1',
      });
      expect(redisService.expire).toHaveBeenCalledWith('monitoring:active_users:2026-03-11', 86400);
    });

    it('should use today date key when date is not provided', async () => {
      mockRedisClient.zadd.mockResolvedValue(1);
      mockRedisService.expire.mockResolvedValue(1);
      const timestamp = Date.now();
      const today = new Date().toISOString().split('T')[0];

      await service.addActiveUser('user-1', timestamp);

      expect(mockRedisClient.zadd).toHaveBeenCalledWith(`monitoring:active_users:${today}`, {
        score: timestamp,
        member: 'user-1',
      });
    });

    it('should handle errors gracefully without throwing', async () => {
      mockRedisClient.zadd.mockRejectedValue(new Error('Redis error'));

      await expect(service.addActiveUser('user-1', Date.now())).resolves.not.toThrow();
    });
  });

  // ========================================
  // getActiveUsers
  // ========================================

  describe('getActiveUsers', () => {
    it('should return list of active users for given date', async () => {
      mockRedisClient.zrange.mockResolvedValue(['user-1', 'user-2']);

      const result = await service.getActiveUsers('2026-03-11');

      expect(result).toEqual(['user-1', 'user-2']);
      expect(mockRedisClient.zrange).toHaveBeenCalledWith(
        'monitoring:active_users:2026-03-11',
        0,
        -1,
      );
    });

    it('should return empty array when Redis returns null', async () => {
      mockRedisClient.zrange.mockResolvedValue(null);

      const result = await service.getActiveUsers('2026-03-11');

      expect(result).toEqual([]);
    });

    it('should return empty array on error', async () => {
      mockRedisClient.zrange.mockRejectedValue(new Error('Redis error'));

      const result = await service.getActiveUsers('2026-03-11');

      expect(result).toEqual([]);
    });
  });

  // ========================================
  // getActiveUserCount
  // ========================================

  describe('getActiveUserCount', () => {
    it('should return count of active users for given date', async () => {
      mockRedisClient.zcard.mockResolvedValue(5);

      const result = await service.getActiveUserCount('2026-03-11');

      expect(result).toBe(5);
      expect(mockRedisClient.zcard).toHaveBeenCalledWith('monitoring:active_users:2026-03-11');
    });

    it('should return 0 when Redis returns null', async () => {
      mockRedisClient.zcard.mockResolvedValue(null);

      const result = await service.getActiveUserCount('2026-03-11');

      expect(result).toBe(0);
    });

    it('should return 0 on error', async () => {
      mockRedisClient.zcard.mockRejectedValue(new Error('Redis error'));

      const result = await service.getActiveUserCount('2026-03-11');

      expect(result).toBe(0);
    });
  });

  // ========================================
  // addActiveChat
  // ========================================

  describe('addActiveChat', () => {
    it('should add chat to sorted set with correct score and expire', async () => {
      mockRedisClient.zadd.mockResolvedValue(1);
      mockRedisService.expire.mockResolvedValue(1);
      const timestamp = Date.now();

      await service.addActiveChat('chat-1', timestamp, '2026-03-11');

      expect(mockRedisClient.zadd).toHaveBeenCalledWith('monitoring:active_chats:2026-03-11', {
        score: timestamp,
        member: 'chat-1',
      });
      expect(redisService.expire).toHaveBeenCalledWith('monitoring:active_chats:2026-03-11', 86400);
    });

    it('should handle errors gracefully without throwing', async () => {
      mockRedisClient.zadd.mockRejectedValue(new Error('Redis error'));

      await expect(service.addActiveChat('chat-1', Date.now())).resolves.not.toThrow();
    });
  });

  // ========================================
  // getActiveChats
  // ========================================

  describe('getActiveChats', () => {
    it('should return list of active chats for given date', async () => {
      mockRedisClient.zrange.mockResolvedValue(['chat-1', 'chat-2', 'chat-3']);

      const result = await service.getActiveChats('2026-03-11');

      expect(result).toEqual(['chat-1', 'chat-2', 'chat-3']);
    });

    it('should return empty array when Redis returns null', async () => {
      mockRedisClient.zrange.mockResolvedValue(null);

      const result = await service.getActiveChats('2026-03-11');

      expect(result).toEqual([]);
    });

    it('should return empty array on error', async () => {
      mockRedisClient.zrange.mockRejectedValue(new Error('Redis error'));

      const result = await service.getActiveChats('2026-03-11');

      expect(result).toEqual([]);
    });
  });

  // ========================================
  // getActiveChatCount
  // ========================================

  describe('getActiveChatCount', () => {
    it('should return count of active chats', async () => {
      mockRedisClient.zcard.mockResolvedValue(3);

      const result = await service.getActiveChatCount('2026-03-11');

      expect(result).toBe(3);
    });

    it('should return 0 on error', async () => {
      mockRedisClient.zcard.mockRejectedValue(new Error('Redis error'));

      const result = await service.getActiveChatCount('2026-03-11');

      expect(result).toBe(0);
    });
  });

  // ========================================
  // setCurrentProcessing / getCurrentProcessing
  // ========================================

  describe('setCurrentProcessing', () => {
    it('should set current processing count as string', async () => {
      mockRedisService.set.mockResolvedValue('OK');

      await service.setCurrentProcessing(5);

      expect(redisService.set).toHaveBeenCalledWith('monitoring:current_processing', '5');
    });

    it('should handle errors gracefully without throwing', async () => {
      mockRedisService.set.mockRejectedValue(new Error('Redis error'));

      await expect(service.setCurrentProcessing(5)).resolves.not.toThrow();
    });
  });

  describe('getCurrentProcessing', () => {
    it('should return parsed current processing count', async () => {
      mockRedisService.get.mockResolvedValue('7');

      const result = await service.getCurrentProcessing();

      expect(result).toBe(7);
    });

    it('should return 0 when Redis returns null', async () => {
      mockRedisService.get.mockResolvedValue(null);

      const result = await service.getCurrentProcessing();

      expect(result).toBe(0);
    });

    it('should return 0 on error', async () => {
      mockRedisService.get.mockRejectedValue(new Error('Redis error'));

      const result = await service.getCurrentProcessing();

      expect(result).toBe(0);
    });
  });

  // ========================================
  // incrementCurrentProcessing
  // ========================================

  describe('incrementCurrentProcessing', () => {
    it('should call incrby with delta and return new value', async () => {
      mockRedisClient.incrby.mockResolvedValue(3);

      const result = await service.incrementCurrentProcessing(1);

      expect(result).toBe(3);
      expect(mockRedisClient.incrby).toHaveBeenCalledWith('monitoring:current_processing', 1);
    });

    it('should support negative delta for decrement', async () => {
      mockRedisClient.incrby.mockResolvedValue(2);

      const result = await service.incrementCurrentProcessing(-1);

      expect(result).toBe(2);
      expect(mockRedisClient.incrby).toHaveBeenCalledWith('monitoring:current_processing', -1);
    });

    it('should return 0 on error', async () => {
      mockRedisClient.incrby.mockRejectedValue(new Error('Redis error'));

      const result = await service.incrementCurrentProcessing(1);

      expect(result).toBe(0);
    });
  });

  // ========================================
  // updatePeakProcessing / getPeakProcessing
  // ========================================

  describe('getPeakProcessing', () => {
    it('should return parsed peak processing value', async () => {
      mockRedisService.get.mockResolvedValue('15');

      const result = await service.getPeakProcessing();

      expect(result).toBe(15);
    });

    it('should return 0 when Redis returns null', async () => {
      mockRedisService.get.mockResolvedValue(null);

      const result = await service.getPeakProcessing();

      expect(result).toBe(0);
    });

    it('should return 0 on error', async () => {
      mockRedisService.get.mockRejectedValue(new Error('Redis error'));

      const result = await service.getPeakProcessing();

      expect(result).toBe(0);
    });
  });

  describe('updatePeakProcessing', () => {
    it('should update peak when new count is greater than current', async () => {
      mockRedisService.get.mockResolvedValue('5');
      mockRedisService.set.mockResolvedValue('OK');

      await service.updatePeakProcessing(10);

      expect(redisService.set).toHaveBeenCalledWith('monitoring:peak_processing', '10');
    });

    it('should not update peak when new count is less than current', async () => {
      mockRedisService.get.mockResolvedValue('20');
      mockRedisService.set.mockResolvedValue('OK');

      await service.updatePeakProcessing(10);

      expect(redisService.set).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully without throwing', async () => {
      mockRedisService.get.mockRejectedValue(new Error('Redis error'));

      await expect(service.updatePeakProcessing(10)).resolves.not.toThrow();
    });
  });

  describe('setPeakProcessing', () => {
    it('should set peak processing directly', async () => {
      mockRedisService.set.mockResolvedValue('OK');

      await service.setPeakProcessing(25);

      expect(redisService.set).toHaveBeenCalledWith('monitoring:peak_processing', '25');
    });

    it('should handle errors gracefully without throwing', async () => {
      mockRedisService.set.mockRejectedValue(new Error('Redis error'));

      await expect(service.setPeakProcessing(25)).resolves.not.toThrow();
    });
  });

  // ========================================
  // clearAll
  // ========================================

  describe('clearAll', () => {
    it('should delete all monitoring keys including pattern-matched keys', async () => {
      mockRedisClient.keys.mockResolvedValue(['monitoring:active_users:2026-03-11']);
      mockRedisService.del.mockResolvedValue(1);

      await service.clearAll();

      expect(redisService.del).toHaveBeenCalledWith('monitoring:counters');
      expect(redisService.del).toHaveBeenCalledWith('monitoring:current_processing');
      expect(redisService.del).toHaveBeenCalledWith('monitoring:peak_processing');
      expect(redisService.del).toHaveBeenCalledWith('monitoring:active_users:2026-03-11');
    });

    it('should skip pattern keys that have no matches', async () => {
      mockRedisClient.keys.mockResolvedValue([]);
      mockRedisService.del.mockResolvedValue(1);

      await service.clearAll();

      // Only exact key deletions should be called (not pattern ones)
      expect(redisService.del).toHaveBeenCalledTimes(3);
    });

    it('should handle errors gracefully without throwing', async () => {
      mockRedisClient.keys.mockRejectedValue(new Error('Redis error'));

      await expect(service.clearAll()).resolves.not.toThrow();
    });
  });
});

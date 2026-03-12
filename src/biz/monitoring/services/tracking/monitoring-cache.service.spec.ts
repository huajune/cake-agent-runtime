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
    incrby: jest.fn(),
    pipeline: jest.fn(() => mockPipeline),
  };

  const mockRedisService = {
    getClient: jest.fn(() => mockRedisClient),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
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
    it('should delete the 3 monitoring keys', async () => {
      mockRedisService.del.mockResolvedValue(1);

      await service.clearAll();

      expect(redisService.del).toHaveBeenCalledWith('monitoring:counters');
      expect(redisService.del).toHaveBeenCalledWith('monitoring:current_processing');
      expect(redisService.del).toHaveBeenCalledWith('monitoring:peak_processing');
      expect(redisService.del).toHaveBeenCalledTimes(3);
    });

    it('should handle errors gracefully without throwing', async () => {
      mockRedisService.del.mockRejectedValue(new Error('Redis error'));

      await expect(service.clearAll()).resolves.not.toThrow();
    });
  });
});

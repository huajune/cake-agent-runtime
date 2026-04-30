import { Test, TestingModule } from '@nestjs/testing';
import { MonitoringCacheService } from '@biz/monitoring/services/tracking/monitoring-cache.service';
import { RedisService } from '@infra/redis/redis.service';

describe('MonitoringCacheService', () => {
  let service: MonitoringCacheService;

  const redisStore = new Map<string, number>();

  const mockRedisService = {
    get: jest.fn(async (key: string) => (redisStore.has(key) ? redisStore.get(key)! : null)),
    set: jest.fn(async (key: string, value: number) => {
      redisStore.set(key, value);
    }),
    incrby: jest.fn(async (key: string, delta: number) => {
      const next = (redisStore.get(key) ?? 0) + delta;
      redisStore.set(key, next);
      return next;
    }),
  };

  beforeEach(async () => {
    redisStore.clear();

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
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('incrementCounter', () => {
    it('should increment the specified counter field', async () => {
      await service.incrementCounter('totalMessages', 1);
      const counters = await service.getCounters();
      expect(counters.totalMessages).toBe(1);
    });

    it('should use default value of 1 when value is not provided', async () => {
      await service.incrementCounter('totalSuccess');
      const counters = await service.getCounters();
      expect(counters.totalSuccess).toBe(1);
    });

    it('should accumulate multiple increments', async () => {
      await service.incrementCounter('totalMessages', 3);
      await service.incrementCounter('totalMessages', 2);
      const counters = await service.getCounters();
      expect(counters.totalMessages).toBe(5);
    });
  });

  describe('incrementCounters', () => {
    it('should increment multiple fields at once', async () => {
      await service.incrementCounters({ totalSuccess: 1, totalFallback: 2 });
      const counters = await service.getCounters();
      expect(counters.totalSuccess).toBe(1);
      expect(counters.totalFallback).toBe(2);
    });

    it('should not affect fields not in the update', async () => {
      await service.incrementCounters({ totalSuccess: 1 });
      const counters = await service.getCounters();
      expect(counters.totalMessages).toBe(0);
      expect(counters.totalFailure).toBe(0);
    });
  });

  describe('getCounters', () => {
    it('should return all zeroes by default', async () => {
      const result = await service.getCounters();
      expect(result).toEqual({
        totalMessages: 0,
        totalSuccess: 0,
        totalFailure: 0,
        totalAiDuration: 0,
        totalSendDuration: 0,
        totalFallback: 0,
        totalFallbackSuccess: 0,
        totalOutputLeakSkipped: 0,
        totalHostingPausedSkipped: 0,
      });
    });

    it('should return a copy, not the internal reference', async () => {
      const result1 = await service.getCounters();
      result1.totalMessages = 999;
      const result2 = await service.getCounters();
      expect(result2.totalMessages).toBe(0);
    });
  });

  describe('resetCounters', () => {
    it('should reset all counters to zero', async () => {
      await service.incrementCounter('totalMessages', 10);
      await service.incrementCounter('totalSuccess', 8);

      await service.resetCounters();

      const result = await service.getCounters();
      expect(result).toEqual({
        totalMessages: 0,
        totalSuccess: 0,
        totalFailure: 0,
        totalAiDuration: 0,
        totalSendDuration: 0,
        totalFallback: 0,
        totalFallbackSuccess: 0,
        totalOutputLeakSkipped: 0,
        totalHostingPausedSkipped: 0,
      });
    });
  });

  describe('setCounters', () => {
    it('should replace all counters with provided values', async () => {
      const counters = {
        totalMessages: 100,
        totalSuccess: 90,
        totalFailure: 10,
        totalAiDuration: 50000,
        totalSendDuration: 30000,
        totalFallback: 5,
        totalFallbackSuccess: 4,
        totalOutputLeakSkipped: 2,
        totalHostingPausedSkipped: 4,
      };

      await service.setCounters(counters);

      const result = await service.getCounters();
      expect(result).toEqual(counters);
    });
  });

  describe('active request counters', () => {
    it('should set and get active requests', async () => {
      await service.setActiveRequests(5);
      expect(await service.getActiveRequests()).toBe(5);
    });

    it('should increment and return the new active request count', async () => {
      expect(await service.incrementActiveRequests()).toBe(1);
      expect(await service.incrementActiveRequests(2)).toBe(3);
      expect(await service.getActiveRequests()).toBe(3);
    });

    it('should clamp decrements below zero', async () => {
      expect(await service.incrementActiveRequests(-1)).toBe(0);
      expect(await service.getActiveRequests()).toBe(0);
    });
  });

  describe('peak active requests', () => {
    it('should return 0 by default', async () => {
      expect(await service.getPeakActiveRequests()).toBe(0);
    });

    it('should update peak when active requests grows', async () => {
      await service.incrementActiveRequests(3);
      await service.incrementActiveRequests(2);

      expect(await service.getPeakActiveRequests()).toBe(5);
    });

    it('should not lower peak after active requests decreases', async () => {
      await service.setPeakActiveRequests(8);
      await service.incrementActiveRequests(3);
      await service.incrementActiveRequests(-2);

      expect(await service.getPeakActiveRequests()).toBe(8);
    });

    it('should update peak directly', async () => {
      await service.setPeakActiveRequests(25);
      expect(await service.getPeakActiveRequests()).toBe(25);
    });
  });

  describe('clearAll', () => {
    it('should reset counters and realtime request metrics', async () => {
      await service.incrementCounter('totalMessages', 10);
      await service.setActiveRequests(5);
      await service.setPeakActiveRequests(15);

      await service.clearAll();

      const counters = await service.getCounters();
      expect(counters.totalMessages).toBe(0);
      expect(await service.getActiveRequests()).toBe(0);
      expect(await service.getPeakActiveRequests()).toBe(0);
    });
  });
});

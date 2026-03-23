import { Test, TestingModule } from '@nestjs/testing';
import { MonitoringCacheService } from '@biz/monitoring/services/tracking/monitoring-cache.service';

describe('MonitoringCacheService', () => {
  let service: MonitoringCacheService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MonitoringCacheService],
    }).compile();

    service = module.get<MonitoringCacheService>(MonitoringCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========================================
  // incrementCounter
  // ========================================

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

  // ========================================
  // incrementCounters
  // ========================================

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

  // ========================================
  // getCounters
  // ========================================

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
      });
    });

    it('should return a copy, not the internal reference', async () => {
      const result1 = await service.getCounters();
      result1.totalMessages = 999;
      const result2 = await service.getCounters();
      expect(result2.totalMessages).toBe(0);
    });
  });

  // ========================================
  // resetCounters
  // ========================================

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
      });
    });
  });

  // ========================================
  // setCounters
  // ========================================

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
      };

      await service.setCounters(counters);

      const result = await service.getCounters();
      expect(result).toEqual(counters);
    });
  });

  // ========================================
  // setCurrentProcessing / getCurrentProcessing
  // ========================================

  describe('setCurrentProcessing', () => {
    it('should set current processing count', async () => {
      await service.setCurrentProcessing(5);
      const result = await service.getCurrentProcessing();
      expect(result).toBe(5);
    });
  });

  describe('getCurrentProcessing', () => {
    it('should return 0 by default', async () => {
      const result = await service.getCurrentProcessing();
      expect(result).toBe(0);
    });
  });

  // ========================================
  // incrementCurrentProcessing
  // ========================================

  describe('incrementCurrentProcessing', () => {
    it('should increment and return new value', async () => {
      const result = await service.incrementCurrentProcessing(1);
      expect(result).toBe(1);
    });

    it('should support negative delta for decrement', async () => {
      await service.incrementCurrentProcessing(3);
      const result = await service.incrementCurrentProcessing(-1);
      expect(result).toBe(2);
    });

    it('should use default delta of 1', async () => {
      const result = await service.incrementCurrentProcessing();
      expect(result).toBe(1);
    });
  });

  // ========================================
  // updatePeakProcessing / getPeakProcessing
  // ========================================

  describe('getPeakProcessing', () => {
    it('should return 0 by default', async () => {
      const result = await service.getPeakProcessing();
      expect(result).toBe(0);
    });
  });

  describe('updatePeakProcessing', () => {
    it('should update peak when new count is greater than current', async () => {
      await service.updatePeakProcessing(10);
      expect(await service.getPeakProcessing()).toBe(10);
    });

    it('should not update peak when new count is less than current', async () => {
      await service.setPeakProcessing(20);
      await service.updatePeakProcessing(10);
      expect(await service.getPeakProcessing()).toBe(20);
    });

    it('should not update peak when new count equals current', async () => {
      await service.setPeakProcessing(10);
      await service.updatePeakProcessing(10);
      expect(await service.getPeakProcessing()).toBe(10);
    });
  });

  describe('setPeakProcessing', () => {
    it('should set peak processing directly', async () => {
      await service.setPeakProcessing(25);
      expect(await service.getPeakProcessing()).toBe(25);
    });
  });

  // ========================================
  // clearAll
  // ========================================

  describe('clearAll', () => {
    it('should reset counters, currentProcessing, and peakProcessing', async () => {
      await service.incrementCounter('totalMessages', 10);
      await service.setCurrentProcessing(5);
      await service.setPeakProcessing(15);

      await service.clearAll();

      const counters = await service.getCounters();
      expect(counters.totalMessages).toBe(0);
      expect(await service.getCurrentProcessing()).toBe(0);
      expect(await service.getPeakProcessing()).toBe(0);
    });
  });
});

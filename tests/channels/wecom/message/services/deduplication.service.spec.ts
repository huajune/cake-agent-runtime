import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MessageDeduplicationService } from '@wecom/message/runtime/deduplication.service';
import { RedisService } from '@infra/redis/redis.service';
import { RedisKeyBuilder } from '@wecom/message/runtime/redis-key.util';

describe('MessageDeduplicationService', () => {
  let service: MessageDeduplicationService;

  const mockRedisClient = {
    set: jest.fn(),
  };

  const mockRedisService = {
    exists: jest.fn(),
    scan: jest.fn(),
    del: jest.fn(),
    getClient: jest.fn(() => mockRedisClient),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue?: string) => {
      if (key === 'MESSAGE_DEDUP_TTL_SECONDS') return '300';
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageDeduplicationService,
        { provide: RedisService, useValue: mockRedisService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<MessageDeduplicationService>(MessageDeduplicationService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should log initialization message', async () => {
      await expect(service.onModuleInit()).resolves.not.toThrow();
    });
  });

  describe('isMessageProcessedAsync', () => {
    it('should return true when message key exists in Redis', async () => {
      mockRedisService.exists.mockResolvedValue(1);

      const result = await service.isMessageProcessedAsync('msg-123');

      expect(result).toBe(true);
      expect(mockRedisService.exists).toHaveBeenCalledWith(RedisKeyBuilder.dedup('msg-123'));
    });

    it('should return false when message key does not exist in Redis', async () => {
      mockRedisService.exists.mockResolvedValue(0);

      const result = await service.isMessageProcessedAsync('msg-456');

      expect(result).toBe(false);
      expect(mockRedisService.exists).toHaveBeenCalledWith(RedisKeyBuilder.dedup('msg-456'));
    });
  });

  describe('markMessageAsProcessedAsync', () => {
    it('should return true and set key when message not yet processed', async () => {
      mockRedisClient.set.mockResolvedValue('OK');

      const result = await service.markMessageAsProcessedAsync('msg-123');

      expect(result).toBe(true);
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        RedisKeyBuilder.dedup('msg-123'),
        expect.any(String),
        { nx: true, ex: 300 },
      );
    });

    it('should return false when message already processed by another process', async () => {
      mockRedisClient.set.mockResolvedValue(null);

      const result = await service.markMessageAsProcessedAsync('msg-123');

      expect(result).toBe(false);
    });
  });

  describe('clearAll', () => {
    it('should scan and delete all dedup keys', async () => {
      mockRedisService.scan
        .mockResolvedValueOnce(['5', ['wecom:dedup:msg-1', 'wecom:dedup:msg-2']])
        .mockResolvedValueOnce(['0', ['wecom:dedup:msg-3']]);
      mockRedisService.del.mockResolvedValue(2);

      await service.clearAll();

      expect(mockRedisService.scan).toHaveBeenCalledTimes(2);
      expect(mockRedisService.del).toHaveBeenCalledTimes(2);
    });

    it('should handle empty scan result gracefully', async () => {
      mockRedisService.scan.mockResolvedValueOnce(['0', []]);

      await service.clearAll();

      expect(mockRedisService.del).not.toHaveBeenCalled();
    });

    it('should stop scanning when cursor is 0', async () => {
      mockRedisService.scan.mockResolvedValueOnce(['0', ['wecom:dedup:msg-1']]);
      mockRedisService.del.mockResolvedValue(1);

      await service.clearAll();

      expect(mockRedisService.scan).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStats', () => {
    it('should return stats object with redis storage info', () => {
      const stats = service.getStats();

      expect(stats).toMatchObject({
        storage: 'redis',
        ttlSeconds: 300,
      });
      expect(typeof stats.keyPattern).toBe('string');
    });
  });

  describe('cleanupExpiredMessages', () => {
    it('should return 0 (Redis TTL manages cleanup)', () => {
      const result = service.cleanupExpiredMessages();
      expect(result).toBe(0);
    });
  });
});

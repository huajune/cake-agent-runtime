import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@infra/redis/redis.service';

// Mock the @upstash/redis module
const mockRedisClient = {
  ping: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  exists: jest.fn(),
  scan: jest.fn(),
  rpush: jest.fn(),
  lrange: jest.fn(),
  ltrim: jest.fn(),
  llen: jest.fn(),
  expire: jest.fn(),
};

jest.mock('@upstash/redis', () => ({
  Redis: jest.fn(() => mockRedisClient),
}));

describe('RedisService', () => {
  let service: RedisService;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      const config: Record<string, string> = {
        UPSTASH_REDIS_REST_URL: 'https://test-redis.upstash.io',
        UPSTASH_REDIS_REST_TOKEN: 'test-token',
      };
      return config[key];
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [RedisService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    service = module.get<RedisService>(RedisService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== onModuleInit ====================

  describe('onModuleInit', () => {
    it('should ping Redis on module init', async () => {
      mockRedisClient.ping.mockResolvedValue('PONG');

      await service.onModuleInit();

      expect(mockRedisClient.ping).toHaveBeenCalledTimes(1);
    });

    it('should throw error when ping fails', async () => {
      mockRedisClient.ping.mockRejectedValue(new Error('Connection refused'));

      await expect(service.onModuleInit()).rejects.toThrow('Connection refused');
    });
  });

  // ==================== getClient ====================

  describe('getClient', () => {
    it('should return the Redis client instance', () => {
      const client = service.getClient();
      expect(client).toBe(mockRedisClient);
    });
  });

  // ==================== get ====================

  describe('get', () => {
    it('should return value from Redis', async () => {
      mockRedisClient.get.mockResolvedValue({ key: 'value' });

      const result = await service.get<{ key: string }>('test-key');

      expect(result).toEqual({ key: 'value' });
      expect(mockRedisClient.get).toHaveBeenCalledWith('test-key');
    });

    it('should return null when key does not exist', async () => {
      mockRedisClient.get.mockResolvedValue(null);

      const result = await service.get('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ==================== set ====================

  describe('set', () => {
    it('should set value in Redis', async () => {
      mockRedisClient.set.mockResolvedValue('OK');

      await service.set('test-key', 'test-value');

      expect(mockRedisClient.set).toHaveBeenCalledWith('test-key', 'test-value');
    });

    it('should handle complex object values', async () => {
      mockRedisClient.set.mockResolvedValue('OK');

      const value = { name: 'test', count: 5 };
      await service.set('complex-key', value);

      expect(mockRedisClient.set).toHaveBeenCalledWith('complex-key', value);
    });
  });

  // ==================== setex ====================

  describe('setex', () => {
    it('should set value with expiry in Redis', async () => {
      mockRedisClient.setex.mockResolvedValue('OK');

      await service.setex('test-key', 300, 'test-value');

      expect(mockRedisClient.setex).toHaveBeenCalledWith('test-key', 300, 'test-value');
    });

    it('should handle array values', async () => {
      mockRedisClient.setex.mockResolvedValue('OK');

      const items = [{ id: '1' }, { id: '2' }];
      await service.setex('list-key', 600, items);

      expect(mockRedisClient.setex).toHaveBeenCalledWith('list-key', 600, items);
    });
  });

  // ==================== del ====================

  describe('del', () => {
    it('should delete a key and return count', async () => {
      mockRedisClient.del.mockResolvedValue(1);

      const result = await service.del('key-to-delete');

      expect(result).toBe(1);
      expect(mockRedisClient.del).toHaveBeenCalledWith('key-to-delete');
    });

    it('should delete multiple keys', async () => {
      mockRedisClient.del.mockResolvedValue(3);

      const result = await service.del('key1', 'key2', 'key3');

      expect(result).toBe(3);
      expect(mockRedisClient.del).toHaveBeenCalledWith('key1', 'key2', 'key3');
    });

    it('should return 0 when key does not exist', async () => {
      mockRedisClient.del.mockResolvedValue(0);

      const result = await service.del('nonexistent');

      expect(result).toBe(0);
    });
  });

  // ==================== exists ====================

  describe('exists', () => {
    it('should return 1 when key exists', async () => {
      mockRedisClient.exists.mockResolvedValue(1);

      const result = await service.exists('existing-key');

      expect(result).toBe(1);
      expect(mockRedisClient.exists).toHaveBeenCalledWith('existing-key');
    });

    it('should return 0 when key does not exist', async () => {
      mockRedisClient.exists.mockResolvedValue(0);

      const result = await service.exists('nonexistent');

      expect(result).toBe(0);
    });

    it('should check multiple keys', async () => {
      mockRedisClient.exists.mockResolvedValue(2);

      const result = await service.exists('key1', 'key2');

      expect(result).toBe(2);
      expect(mockRedisClient.exists).toHaveBeenCalledWith('key1', 'key2');
    });
  });

  // ==================== scan ====================

  describe('scan', () => {
    it('should scan with cursor and options', async () => {
      mockRedisClient.scan.mockResolvedValue(['0', ['key1', 'key2']]);

      const result = await service.scan(0, { match: 'prefix:*', count: 100 });

      expect(result).toEqual(['0', ['key1', 'key2']]);
      expect(mockRedisClient.scan).toHaveBeenCalledWith(0, { match: 'prefix:*', count: 100 });
    });

    it('should scan without options', async () => {
      mockRedisClient.scan.mockResolvedValue(['0', []]);

      await service.scan('0');

      expect(mockRedisClient.scan).toHaveBeenCalledWith('0', undefined);
    });
  });

  // ==================== ping ====================

  describe('ping', () => {
    it('should return PONG', async () => {
      mockRedisClient.ping.mockResolvedValue('PONG');

      const result = await service.ping();

      expect(result).toBe('PONG');
    });
  });

  // ==================== rpush ====================

  describe('rpush', () => {
    it('should push values to list and return list length', async () => {
      mockRedisClient.rpush.mockResolvedValue(3);

      const result = await service.rpush('list-key', 'val1', 'val2', 'val3');

      expect(result).toBe(3);
      expect(mockRedisClient.rpush).toHaveBeenCalledWith('list-key', 'val1', 'val2', 'val3');
    });
  });

  // ==================== lrange ====================

  describe('lrange', () => {
    it('should return list elements in range', async () => {
      const mockItems = ['item1', 'item2', 'item3'];
      mockRedisClient.lrange.mockResolvedValue(mockItems);

      const result = await service.lrange('list-key', 0, -1);

      expect(result).toEqual(mockItems);
      expect(mockRedisClient.lrange).toHaveBeenCalledWith('list-key', 0, -1);
    });

    it('should return empty array when list is empty', async () => {
      mockRedisClient.lrange.mockResolvedValue([]);

      const result = await service.lrange('empty-list', 0, 10);

      expect(result).toEqual([]);
    });
  });

  // ==================== ltrim ====================

  describe('ltrim', () => {
    it('should trim list to specified range', async () => {
      mockRedisClient.ltrim.mockResolvedValue('OK');

      await service.ltrim('list-key', 0, 9);

      expect(mockRedisClient.ltrim).toHaveBeenCalledWith('list-key', 0, 9);
    });
  });

  // ==================== llen ====================

  describe('llen', () => {
    it('should return list length', async () => {
      mockRedisClient.llen.mockResolvedValue(5);

      const result = await service.llen('list-key');

      expect(result).toBe(5);
      expect(mockRedisClient.llen).toHaveBeenCalledWith('list-key');
    });

    it('should return 0 for empty list', async () => {
      mockRedisClient.llen.mockResolvedValue(0);

      const result = await service.llen('empty-list');

      expect(result).toBe(0);
    });
  });

  // ==================== expire ====================

  describe('expire', () => {
    it('should set expiry and return 1 on success', async () => {
      mockRedisClient.expire.mockResolvedValue(1);

      const result = await service.expire('test-key', 300);

      expect(result).toBe(1);
      expect(mockRedisClient.expire).toHaveBeenCalledWith('test-key', 300);
    });

    it('should return 0 when key does not exist', async () => {
      mockRedisClient.expire.mockResolvedValue(0);

      const result = await service.expire('nonexistent', 300);

      expect(result).toBe(0);
    });
  });
});

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
  incrby: jest.fn(),
  eval: jest.fn(),
};

jest.mock('@upstash/redis', () => ({
  Redis: jest.fn(() => mockRedisClient),
}));

/** 测试环境 env 前缀（对应 mockConfigService 的 RUNTIME_ENV） */
const ENV = 'test';
const prefixed = (key: string) => `${ENV}:${key}`;

describe('RedisService', () => {
  let service: RedisService;

  const mockConfigService = {
    get: jest.fn((key: string) => {
      const config: Record<string, string> = {
        RUNTIME_ENV: ENV,
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

  describe('getClient', () => {
    it('should return the Redis client instance', () => {
      expect(service.getClient()).toBe(mockRedisClient);
    });
  });

  describe('getEnvironment', () => {
    it('should expose configured RUNTIME_ENV', () => {
      expect(service.getEnvironment()).toBe(ENV);
    });
  });

  describe('get', () => {
    it('prefixes key before reading', async () => {
      mockRedisClient.get.mockResolvedValue({ key: 'value' });
      const result = await service.get<{ key: string }>('test-key');

      expect(result).toEqual({ key: 'value' });
      expect(mockRedisClient.get).toHaveBeenCalledWith(prefixed('test-key'));
    });
  });

  describe('set', () => {
    it('prefixes key before writing', async () => {
      mockRedisClient.set.mockResolvedValue('OK');
      await service.set('test-key', 'test-value');

      expect(mockRedisClient.set).toHaveBeenCalledWith(prefixed('test-key'), 'test-value');
    });
  });

  describe('setex', () => {
    it('prefixes key for setex', async () => {
      mockRedisClient.setex.mockResolvedValue('OK');
      await service.setex('test-key', 300, 'test-value');

      expect(mockRedisClient.setex).toHaveBeenCalledWith(prefixed('test-key'), 300, 'test-value');
    });
  });

  describe('setNx', () => {
    it('returns true when Redis SET NX succeeds', async () => {
      mockRedisClient.set.mockResolvedValue('OK');
      const acquired = await service.setNx('lock-key', 'owner-1', 30);

      expect(acquired).toBe(true);
      expect(mockRedisClient.set).toHaveBeenCalledWith(prefixed('lock-key'), 'owner-1', {
        nx: true,
        ex: 30,
      });
    });

    it('returns false when Redis SET NX returns null (key exists)', async () => {
      mockRedisClient.set.mockResolvedValue(null);
      const acquired = await service.setNx('lock-key', 'owner-1', 30);
      expect(acquired).toBe(false);
    });
  });

  describe('del', () => {
    it('prefixes a single key', async () => {
      mockRedisClient.del.mockResolvedValue(1);
      await service.del('key-to-delete');
      expect(mockRedisClient.del).toHaveBeenCalledWith(prefixed('key-to-delete'));
    });

    it('prefixes multiple keys', async () => {
      mockRedisClient.del.mockResolvedValue(3);
      await service.del('key1', 'key2', 'key3');
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        prefixed('key1'),
        prefixed('key2'),
        prefixed('key3'),
      );
    });
  });

  describe('exists', () => {
    it('prefixes keys passed to exists', async () => {
      mockRedisClient.exists.mockResolvedValue(2);
      await service.exists('key1', 'key2');
      expect(mockRedisClient.exists).toHaveBeenCalledWith(prefixed('key1'), prefixed('key2'));
    });
  });

  describe('expire', () => {
    it('prefixes key when setting expiry', async () => {
      mockRedisClient.expire.mockResolvedValue(1);
      await service.expire('test-key', 300);
      expect(mockRedisClient.expire).toHaveBeenCalledWith(prefixed('test-key'), 300);
    });
  });

  describe('incrby', () => {
    it('prefixes key and returns new value', async () => {
      mockRedisClient.incrby.mockResolvedValue(5);
      const result = await service.incrby('counter', 3);

      expect(result).toBe(5);
      expect(mockRedisClient.incrby).toHaveBeenCalledWith(prefixed('counter'), 3);
    });
  });

  describe('eval', () => {
    it('prefixes all keys in the KEYS array but leaves ARGV untouched', async () => {
      mockRedisClient.eval.mockResolvedValue(1);
      await service.eval('return 1', ['k1', 'k2'], ['argA', 'argB']);

      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        'return 1',
        [prefixed('k1'), prefixed('k2')],
        ['argA', 'argB'],
      );
    });
  });

  describe('scan', () => {
    it('prefixes match pattern and strips prefix from returned keys', async () => {
      mockRedisClient.scan.mockResolvedValue(['0', [prefixed('key1'), prefixed('key2')]]);

      const result = await service.scan(0, { match: 'prefix:*', count: 100 });

      expect(mockRedisClient.scan).toHaveBeenCalledWith(0, {
        match: prefixed('prefix:*'),
        count: 100,
      });
      expect(result).toEqual(['0', ['key1', 'key2']]);
    });

    it('scans without match pattern', async () => {
      mockRedisClient.scan.mockResolvedValue(['0', []]);
      await service.scan('0');
      expect(mockRedisClient.scan).toHaveBeenCalledWith('0', { match: undefined, count: undefined });
    });
  });

  describe('ping', () => {
    it('does not prefix anything', async () => {
      mockRedisClient.ping.mockResolvedValue('PONG');
      await service.ping();
      expect(mockRedisClient.ping).toHaveBeenCalled();
    });
  });

  describe('rpush', () => {
    it('prefixes list key', async () => {
      mockRedisClient.rpush.mockResolvedValue(3);
      await service.rpush('list-key', 'val1', 'val2', 'val3');
      expect(mockRedisClient.rpush).toHaveBeenCalledWith(
        prefixed('list-key'),
        'val1',
        'val2',
        'val3',
      );
    });
  });

  describe('lrange', () => {
    it('prefixes list key', async () => {
      mockRedisClient.lrange.mockResolvedValue(['a']);
      await service.lrange('list-key', 0, -1);
      expect(mockRedisClient.lrange).toHaveBeenCalledWith(prefixed('list-key'), 0, -1);
    });
  });

  describe('ltrim', () => {
    it('prefixes list key', async () => {
      mockRedisClient.ltrim.mockResolvedValue('OK');
      await service.ltrim('list-key', 0, 9);
      expect(mockRedisClient.ltrim).toHaveBeenCalledWith(prefixed('list-key'), 0, 9);
    });
  });

  describe('llen', () => {
    it('prefixes list key', async () => {
      mockRedisClient.llen.mockResolvedValue(5);
      await service.llen('list-key');
      expect(mockRedisClient.llen).toHaveBeenCalledWith(prefixed('list-key'));
    });
  });
});

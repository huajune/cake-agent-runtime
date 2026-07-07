import { RedisStore } from '@memory/stores/redis.store';

describe('RedisStore', () => {
  const mockRedis = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    setex: jest.fn().mockResolvedValue(undefined),
    eval: jest.fn().mockResolvedValue(1),
    hgetall: jest.fn(),
    del: jest.fn(),
  };

  let store: RedisStore;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new RedisStore(mockRedis as never);
  });

  describe('get', () => {
    it('should return entry from Redis', async () => {
      const entry = { key: 'test', content: { name: '张三' }, updatedAt: '2026-03-18' };
      mockRedis.get.mockResolvedValue(entry);

      const result = await store.get('test');
      expect(result).toEqual(entry);
      expect(mockRedis.get).toHaveBeenCalledWith('test');
    });

    it('should return null when key not found', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await store.get('missing');
      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('should store with TTL via setex', async () => {
      await store.set('test', { name: '张三' }, 3600);
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'test',
        3600,
        expect.objectContaining({
          key: 'test',
          content: { name: '张三' },
          updatedAt: expect.any(String),
        }),
      );
    });

    it('should store without TTL via set', async () => {
      await store.set('test', { name: '张三' });
      expect(mockRedis.set).toHaveBeenCalledWith(
        'test',
        expect.objectContaining({
          key: 'test',
          content: { name: '张三' },
        }),
      );
    });

    it('should deepMerge when merge=true and existing entry', async () => {
      mockRedis.get.mockResolvedValue({
        key: 'test',
        content: { name: '张三', age: '22' },
        updatedAt: '2026-03-17',
      });

      await store.set('test', { phone: '13800138000' }, 3600, true);

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'test',
        3600,
        expect.objectContaining({
          content: { name: '张三', age: '22', phone: '13800138000' },
        }),
      );
    });

    it('should not merge when merge=false', async () => {
      await store.set('test', { phone: '13800138000' }, 3600, false);
      expect(mockRedis.get).not.toHaveBeenCalled();
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'test',
        3600,
        expect.objectContaining({
          content: { phone: '13800138000' },
        }),
      );
    });
  });

  describe('del', () => {
    it('should return true when key deleted', async () => {
      mockRedis.del.mockResolvedValue(1);
      const result = await store.del('test');
      expect(result).toBe(true);
    });

    it('should return false when key not found', async () => {
      mockRedis.del.mockResolvedValue(0);
      const result = await store.del('test');
      expect(result).toBe(false);
    });
  });

  describe('getHash', () => {
    it('should return hash fields when key exists', async () => {
      mockRedis.hgetall.mockResolvedValue({ stage: 'screening' });

      const result = await store.getHash('session:hash');

      expect(result).toEqual({ stage: 'screening' });
      expect(mockRedis.hgetall).toHaveBeenCalledWith('session:hash');
    });

    it('should return null when hash is empty or missing', async () => {
      mockRedis.hgetall.mockResolvedValue({});

      const result = await store.getHash('session:hash');

      expect(result).toBeNull();
    });
  });

  describe('patchHash', () => {
    it('should update fields and refresh TTL in one Lua eval', async () => {
      await store.patchHash(
        'session:hash',
        {
          stage: 'screening',
          score: 88,
          profile: { city: '上海' },
          active: true,
        },
        172800,
      );

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("hset"'),
        ['session:hash'],
        [
          172800,
          'stage',
          'screening',
          'score',
          88,
          'profile',
          JSON.stringify({ city: '上海' }),
          'active',
          'true',
        ],
      );
    });

    it('should skip empty patches', async () => {
      await store.patchHash('session:hash', {}, 172800);

      expect(mockRedis.eval).not.toHaveBeenCalled();
    });
  });

  describe('backfillHash', () => {
    it('should backfill missing fields and refresh TTL in one Lua eval', async () => {
      await store.backfillHash(
        'session:hash',
        {
          stage: 'screening',
          skipped: undefined,
          confidence: 'high',
        },
        172800,
      );

      expect(mockRedis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("hsetnx"'),
        ['session:hash'],
        [172800, 'stage', 'screening', 'confidence', 'high'],
      );
    });

    it('should skip backfill when all fields are undefined', async () => {
      await store.backfillHash('session:hash', { skipped: undefined }, 172800);

      expect(mockRedis.eval).not.toHaveBeenCalled();
    });
  });
});

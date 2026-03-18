import { RedisStore } from '@memory/redis.store';

describe('RedisStore', () => {
  const mockRedis = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    setex: jest.fn().mockResolvedValue(undefined),
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
});

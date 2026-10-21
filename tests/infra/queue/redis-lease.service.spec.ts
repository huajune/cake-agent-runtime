import { RedisLeaseService } from '@infra/queue/redis-lease.service';

describe('RedisLeaseService', () => {
  const redis = { setNx: jest.fn(), eval: jest.fn() };
  const failures = { report: jest.fn().mockResolvedValue(undefined) };
  const service = new RedisLeaseService(redis as never, failures as never);

  beforeEach(() => {
    jest.clearAllMocks();
    redis.setNx.mockResolvedValue(true);
    redis.eval.mockResolvedValue(1);
  });

  it('uses a different owner for each acquisition and never falls open on Redis failure', async () => {
    const first = await service.acquire('lock', 90);
    const second = await service.acquire('lock', 90);
    expect(first?.owner).not.toBe(second?.owner);
    redis.setNx.mockRejectedValue(new Error('redis down'));
    expect(await service.acquire('lock', 90)).toBeNull();
    expect(failures.report).toHaveBeenCalledWith(
      'queue.lease_unavailable',
      'lock',
      expect.any(Error),
    );
  });

  it('requires an owner match for renewal and release; expiry never becomes a new acquisition', async () => {
    const lease = { key: 'lock', owner: 'old-owner', ttlSeconds: 90 };
    redis.eval.mockResolvedValue(0);
    expect(await service.renew(lease)).toBe(false);
    expect(await service.release(lease)).toBe(false);
    expect(redis.setNx).not.toHaveBeenCalled();
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('== ARGV[1]'),
      ['lock'],
      ['old-owner', 90],
    );
    expect(failures.report).toHaveBeenCalledWith('queue.lease_lost', 'lock', expect.any(String));
  });

  it('stops bounded waiting rather than occupying a worker forever', async () => {
    jest.useFakeTimers();
    redis.setNx.mockResolvedValue(false);
    const pending = service.acquire('lock', 90, { waitMs: 50, pollMs: 10 });
    await jest.advanceTimersByTimeAsync(100);
    expect(await pending).toBeNull();
    expect(redis.setNx.mock.calls.length).toBeLessThanOrEqual(6);
    jest.useRealTimers();
  });

  it('reports release transport failure without masking the original business result', async () => {
    redis.eval.mockRejectedValue(new Error('redis down'));
    expect(await service.release({ key: 'lock', owner: 'owner', ttlSeconds: 90 })).toBe(false);
    expect(failures.report).toHaveBeenCalledWith(
      'queue.lease_release_failed',
      'lock',
      expect.any(Error),
    );
  });
});

import { CronRunnerService } from '@infra/queue/cron-runner.service';

describe('CronRunnerService', () => {
  const lease = { key: 'lock', owner: 'owner', ttlSeconds: 60 };
  const leases = { acquire: jest.fn(), renew: jest.fn(), release: jest.fn() };
  const redis = { get: jest.fn(), setex: jest.fn() };
  const failures = { report: jest.fn() };
  const config = { get: jest.fn((_key, fallback) => fallback) };
  const runner = new CronRunnerService(
    leases as never,
    redis as never,
    failures as never,
    config as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    leases.acquire.mockResolvedValue(lease);
    leases.renew.mockResolvedValue(true);
    leases.release.mockResolvedValue(true);
    redis.get.mockResolvedValue(null);
    redis.setex.mockResolvedValue(undefined);
  });

  it('skips all work when lock or lifecycle persistence is unavailable', async () => {
    const task = jest.fn();
    leases.acquire.mockResolvedValueOnce(null);
    await runner.run('test', { timeMs: 1000, maxRows: 1 }, task);
    redis.setex.mockRejectedValueOnce(new Error('redis down'));
    await runner.run('test', { timeMs: 1000, maxRows: 1 }, task);
    expect(task).not.toHaveBeenCalled();
    expect(leases.release).toHaveBeenCalledTimes(1);
  });

  it('stops before an over-budget or lease-lost external write', async () => {
    const write = jest.fn();
    await runner.run('test', { timeMs: 1000, maxRows: 1 }, async (budget) => {
      await budget.checkpoint(2);
      write();
    });
    leases.renew.mockResolvedValueOnce(false);
    await runner.run('test', { timeMs: 1000, maxRows: 1 }, async (budget) => {
      await budget.checkpoint(1);
      write();
    });
    expect(write).not.toHaveBeenCalled();
    expect(failures.report).toHaveBeenCalledTimes(2);
  });

  it('does not release a still-running writer when the time budget elapses', async () => {
    let finish: () => void = () => undefined;
    const task = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const running = runner.run('test', { timeMs: 1, maxRows: 1 }, () => task);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(leases.release).not.toHaveBeenCalled();
    finish();
    await running;
    expect(leases.release).toHaveBeenCalledTimes(1);
  });

  it('reports missed scheduled rounds at startup without executing them', async () => {
    redis.get.mockResolvedValue(Date.now() - 2 * 86400_000);
    await runner.onApplicationBootstrap();
    expect(failures.report).toHaveBeenCalledWith(
      'cron.missed_schedule',
      'ops-daily-report',
      expect.stringContaining('不自动补跑'),
    );
    expect(leases.acquire).not.toHaveBeenCalled();
  });
});

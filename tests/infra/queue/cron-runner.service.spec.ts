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

  it('drains more than one page and stops on a short page', async () => {
    const batch = jest
      .fn()
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(5);
    expect(
      await runner.runBatches(
        'retention',
        { timeMs: 30_000, maxRows: 1000, batchSize: 100 },
        batch,
      ),
    ).toBe(205);
    expect(batch).toHaveBeenCalledTimes(3);
    expect(redis.setex).toHaveBeenLastCalledWith(
      'cron:lifecycle:retention',
      90 * 86400,
      expect.objectContaining({ status: 'completed', rows: 205 }),
    );
    expect(leases.acquire).toHaveBeenCalledTimes(1);
  });

  it('records zero actual rows for an empty batch', async () => {
    await runner.runBatches(
      'retention',
      { timeMs: 30_000, maxRows: 1000, batchSize: 100 },
      async () => 0,
    );
    expect(redis.setex).toHaveBeenLastCalledWith(
      'cron:lifecycle:retention',
      90 * 86400,
      expect.objectContaining({ status: 'completed', rows: 0 }),
    );
  });

  it('limits rows and releases ownership only after the last batch', async () => {
    const batch = jest.fn(async (size) => size);
    expect(
      await runner.runBatches('retention', { timeMs: 30_000, maxRows: 250, batchSize: 100 }, batch),
    ).toBe(250);
    expect(batch.mock.calls.map(([size]) => size)).toEqual([100, 100, 50]);
    expect(leases.release).toHaveBeenCalledTimes(1);
  });

  it('stops batching when time expires or ownership is lost', async () => {
    let now = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const batch = jest.fn(async () => {
        now = 30_001;
        return 100;
      });
      expect(
        await runner.runBatches(
          'retention',
          { timeMs: 30_000, maxRows: 1000, batchSize: 100 },
          batch,
        ),
      ).toBe(100);
      expect(batch).toHaveBeenCalledTimes(1);
      now = 0;
      leases.renew.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const next = jest.fn().mockResolvedValue(100);
      await runner.runBatches('retention', { timeMs: 30_000, maxRows: 1000, batchSize: 100 }, next);
      expect(next).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('does not continue after a failed or invalid batch', async () => {
    for (const batch of [
      jest.fn().mockRejectedValue(new Error('database down')),
      jest.fn().mockResolvedValue(101),
    ]) {
      await runner.runBatches(
        'retention',
        { timeMs: 30_000, maxRows: 1000, batchSize: 100 },
        batch,
      );
      expect(batch).toHaveBeenCalledTimes(1);
    }
    expect(failures.report).toHaveBeenCalledTimes(2);
  });
});

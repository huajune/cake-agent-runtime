import { applyWorkerConcurrency } from '../../scripts/rollout-message-worker-50.cjs';

describe('production first-rollout concurrency', () => {
  const target = { maxConcurrency: 100, concurrency: 50, registeredConcurrency: 50 };
  it('posts 50 to the new version and waits for Bull to register it', async () => {
    const api = jest
      .fn()
      .mockResolvedValueOnce({ ...target, concurrency: 20, registeredConcurrency: 20 })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ ...target, registeredConcurrency: 0 })
      .mockResolvedValueOnce(target);
    const wait = jest.fn();
    await applyWorkerConcurrency(api, wait);
    expect(api.mock.calls.map(([route]) => route)).toEqual([
      'worker-status',
      'worker-concurrency',
      'worker-status',
      'worker-status',
    ]);
    expect(api.mock.calls[1][1]).toEqual({ method: 'POST', body: '{"concurrency":50}' });
    expect(wait).toHaveBeenCalledTimes(1);
  });
  it('can be retried after saving 50 without writing it again', async () => {
    const api = jest.fn().mockResolvedValue(target);
    await applyWorkerConcurrency(api);
    expect(api.mock.calls).toEqual([['worker-status'], ['worker-status']]);
  });
  it('rejects an old version before writing and reports a concurrent operator change', async () => {
    const old = jest.fn().mockResolvedValue({ concurrency: 20, maxConcurrency: 20 });
    await expect(applyWorkerConcurrency(old)).rejects.toThrow('运行版本');
    expect(old).toHaveBeenCalledTimes(1);
    const changed = jest
      .fn()
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce({ ...target, concurrency: 35 });
    await expect(applyWorkerConcurrency(changed)).rejects.toThrow('35');
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

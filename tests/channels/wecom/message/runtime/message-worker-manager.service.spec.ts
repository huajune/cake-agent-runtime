import { MessageWorkerManagerService } from '@channels/wecom/message/runtime/message-worker-manager.service';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('MessageWorkerManagerService', () => {
  function setup(initial?: number) {
    let saved = initial;
    const config = {
      getSystemConfig: jest.fn(async () => ({ workerConcurrency: saved })),
      updateSystemConfig: jest.fn(async ({ workerConcurrency }) => {
        saved = workerConcurrency;
      }),
      getMessageMergeEnabled: jest.fn().mockResolvedValue(true),
    };
    const worker = () => ({
      ready: jest.fn().mockResolvedValue(undefined),
      process: jest.fn().mockImplementation(() => new Promise(() => undefined)),
      close: jest.fn().mockResolvedValue(undefined),
    });
    const createWorker = jest.fn(worker);
    const manager = new MessageWorkerManagerService(config as never);
    const start = () => manager.initialize(createWorker as never, jest.fn());
    return { manager, config, createWorker, worker, start };
  }

  it.each([
    [undefined, 4],
    [20, 20],
    [50, 50],
    [99, 99],
    [120, 100],
    [-1, 1],
    [3.5, 4],
  ])('registers the persisted value %p as %p Bull slots at startup', async (initial, expected) => {
    const { manager, createWorker, start } = setup(initial);
    await start();
    expect(createWorker).toHaveBeenCalledWith(expected);
    expect(createWorker.mock.results[0].value.process).toHaveBeenCalledWith(expect.any(Function));
    expect(await manager.getStatus()).toMatchObject({
      concurrency: expected,
      registeredConcurrency: expected,
      maxConcurrency: 100,
    });
  });

  it.each([0, 101, 1.5, NaN, Infinity])('rejects %p before writing', async (value) => {
    const { manager, config, start } = setup(20);
    await start();
    expect(await manager.setConcurrency(value)).toMatchObject({
      success: false,
      currentConcurrency: 20,
      registeredConcurrency: 20,
    });
    expect(config.updateSystemConfig).not.toHaveBeenCalled();
  });

  it('keeps the running consumer on a failed write', async () => {
    const { manager, config, createWorker, start } = setup(20);
    await start();
    config.updateSystemConfig.mockRejectedValueOnce(new Error('db unavailable'));
    expect(await manager.setConcurrency(50)).toMatchObject({
      success: false,
      currentConcurrency: 20,
      registeredConcurrency: 20,
    });
    expect(createWorker.mock.results[0].value.close).not.toHaveBeenCalled();
  });

  it('serializes competing saves and takes the latest value when the old consumer finishes draining', async () => {
    const { manager, createWorker, start } = setup(20);
    await start();
    let drained: () => void;
    createWorker.mock.results[0].value.close.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        drained = resolve;
      }),
    );
    await Promise.all([manager.setConcurrency(50), manager.setConcurrency(100)]);
    expect(await manager.getStatus()).toMatchObject({ concurrency: 100, registeredConcurrency: 0 });
    expect(createWorker).toHaveBeenCalledTimes(1);
    drained();
    await tick();
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(createWorker).toHaveBeenLastCalledWith(100);
  });

  it('reconciles a setting saved on another instance and preserves it through a failed read', async () => {
    const { manager, config, start } = setup(20);
    await start();
    config.getSystemConfig.mockResolvedValueOnce({ workerConcurrency: 50 });
    await manager.refreshConcurrency();
    await tick();
    config.getSystemConfig.mockRejectedValueOnce(new Error('db unavailable'));
    await manager.refreshConcurrency();
    expect(await manager.getStatus()).toMatchObject({ concurrency: 50, registeredConcurrency: 50 });
    expect(config.updateSystemConfig).not.toHaveBeenCalled();
  });

  it('reports zero on Bull startup failure and retries the saved target on the next check', async () => {
    const { manager, createWorker, worker, start } = setup(50);
    const failed = worker();
    failed.process.mockRejectedValueOnce(new Error('Redis disconnected'));
    createWorker.mockReturnValueOnce(failed);
    await start();
    expect(await manager.getStatus()).toMatchObject({ concurrency: 50, registeredConcurrency: 0 });
    await manager.refreshConcurrency();
    await tick();
    expect(failed.close).toHaveBeenCalled();
    expect(await manager.getStatus()).toMatchObject({ registeredConcurrency: 50 });
  });

  it('stopping during a resize never starts a replacement', async () => {
    const { manager, createWorker, start } = setup(20);
    await start();
    let drained: () => void;
    createWorker.mock.results[0].value.close.mockReturnValue(
      new Promise<void>((resolve) => {
        drained = resolve;
      }),
    );
    await manager.setConcurrency(50);
    const stopping = manager.stop();
    drained();
    await stopping;
    await manager.refreshConcurrency();
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(await manager.setConcurrency(100)).toMatchObject({
      success: false,
      registeredConcurrency: 0,
    });
  });
});

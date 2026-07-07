import { FetchTimeoutError, fetchWithTimeout } from '@infra/utils/fetch-timeout.util';

describe('fetchWithTimeout', () => {
  const originalFetch = global.fetch;
  let clearTimeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearTimeoutSpy.mockRestore();
    jest.useRealTimers();
  });

  it('should return fetch response without aborting normal requests', async () => {
    const response = new Response('ok', { status: 200 });
    const fetchMock = jest.fn().mockResolvedValue(response);
    global.fetch = fetchMock;

    await expect(fetchWithTimeout('https://example.test/ok', { timeoutMs: 1000 })).resolves.toBe(
      response,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/ok',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('should abort timed-out requests and throw FetchTimeoutError with context', async () => {
    let capturedSignal: AbortSignal | undefined;
    global.fetch = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });

    const promise = fetchWithTimeout('https://example.test/slow', { timeoutMs: 50 });
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'FetchTimeoutError',
      url: 'https://example.test/slow',
      timeoutMs: 50,
    } satisfies Partial<FetchTimeoutError>);

    expect(capturedSignal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(50);

    await assertion;
    expect(capturedSignal?.aborted).toBe(true);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it('should rethrow non-timeout fetch failures as-is', async () => {
    const fetchError = new Error('network down');
    global.fetch = jest.fn().mockRejectedValue(fetchError);

    await expect(fetchWithTimeout('https://example.test/fail', { timeoutMs: 1000 })).rejects.toBe(
      fetchError,
    );

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});

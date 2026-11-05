import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { HttpClientFactory } from '@infra/client-http/http-client.factory';
import { redactHttpUrl } from '@infra/client-http/http-log-sanitizer';

describe('HttpClientFactory credential-safe logs', () => {
  let module: TestingModule;
  let factory: HttpClientFactory;
  let log: jest.SpyInstance;
  let debug: jest.SpyInstance;
  let errorLog: jest.SpyInstance;

  beforeEach(async () => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    module = await Test.createTestingModule({ providers: [HttpClientFactory] }).compile();
    factory = module.get(HttpClientFactory);
  });

  afterEach(async () => {
    await module.close();
    jest.restoreAllMocks();
  });

  const logs = () => JSON.stringify([log.mock.calls, debug.mock.calls, errorLog.mock.calls]);

  it('redacts base/request credentials and verbose bodies without changing the transmitted request', async () => {
    const baseURL = 'https://user:base-password@example.test/api?api_key=base-key';
    const url = '/send?token=request-secret&page=2';
    const body = { token: 'body-secret', payload: { text: 'private-message' } };
    const client = factory.create({ baseURL, verbose: true });
    let transmitted: InternalAxiosRequestConfig | undefined;
    client.defaults.adapter = async (config) => {
      transmitted = config;
      return { config, status: 200, statusText: 'OK', headers: {}, data: { ok: true } };
    };

    await expect(client.post(url, body)).resolves.toMatchObject({ data: { ok: true } });

    expect(transmitted?.url).toBe(url);
    expect(transmitted?.baseURL).toBe(baseURL);
    expect(JSON.parse(String(transmitted?.data))).toEqual(body);
    expect(logs()).toContain('/send?token=[REDACTED]&page=2');
    for (const secret of [
      'base-password',
      'base-key',
      'request-secret',
      'body-secret',
      'private-message',
    ])
      expect(logs()).not.toContain(secret);
  });

  it.each(['response', 'network'] as const)(
    'omits reflected secrets and Axios context in %s failure logs while preserving rejection',
    async (kind) => {
      const client = factory.create({});
      let failure: AxiosError | undefined;
      client.defaults.adapter = async (config) => {
        failure = new AxiosError(
          'upstream echoed reflected-secret and request-secret',
          'ERR_BAD_RESPONSE',
          config,
          { token: 'request-secret' },
          kind === 'response'
            ? {
                config,
                status: 503,
                statusText: 'Unavailable',
                headers: {},
                data: { message: 'reflected-secret' },
              }
            : undefined,
        );
        throw failure;
      };

      const request = client.post('/send?token=request-secret', { token: 'body-secret' });
      await expect(request).rejects.toBeInstanceOf(AxiosError);
      await expect(request).rejects.toBe(failure);
      expect(errorLog).toHaveBeenCalled();
      expect(logs()).toContain('/send?token=[REDACTED]');
      for (const secret of ['request-secret', 'reflected-secret', 'body-secret'])
        expect(logs()).not.toContain(secret);
      if (kind === 'response') expect(logs()).toContain('503');
    },
  );

  it('does not serialize a rejected request interceptor error or its secret-bearing cause', async () => {
    const client = factory.create({});
    const failure = Object.assign(new Error('setup-secret'), { cause: { token: 'cause-secret' } });
    const adapter = jest.fn();
    client.defaults.adapter = adapter;
    client.interceptors.request.use(() => {
      throw failure;
    });

    await expect(client.post('/send?token=request-secret')).rejects.toBe(failure);

    expect(adapter).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
    for (const secret of ['setup-secret', 'cause-secret', 'request-secret'])
      expect(logs()).not.toContain(secret);
  });

  it('redacts duplicate, mixed-case and encoded sensitive query names while retaining useful nonsecret query values', () => {
    expect(
      redactHttpUrl(
        '/send?ToKeN=a%2Fb&%61pi_key=key-value&client_secret=client-value&page=3&token=second',
      ),
    ).toBe(
      '/send?ToKeN=[REDACTED]&%61pi_key=[REDACTED]&client_secret=[REDACTED]&page=3&token=[REDACTED]',
    );
  });
});

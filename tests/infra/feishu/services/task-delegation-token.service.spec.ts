import { ConfigService } from '@nestjs/config';
import { TaskDelegationTokenService } from '@infra/feishu/services/task-delegation-token.service';
import {
  openTaskCredentials,
  sealTaskCredentials,
  taskDelegationKey,
  type TaskDelegationCredentials,
} from '@infra/feishu/services/task-delegation-credentials';
import { fetchWithTimeout } from '@infra/utils/fetch-timeout.util';
jest.mock('@infra/utils/fetch-timeout.util', () => ({ fetchWithTimeout: jest.fn() }));
const fetchMock = jest.mocked(fetchWithTimeout);
const secret = Buffer.alloc(32, 1).toString('base64');
const key = taskDelegationKey('app', 'jiang');
const context = `test:${key}`;
const config = new ConfigService({
  FEISHU_APP_ID: 'app',
  FEISHU_APP_SECRET: 'app-secret',
  FEISHU_TASK_DELEGATOR_OPEN_ID: 'jiang',
  FEISHU_TASK_DELEGATOR_ENCRYPTION_KEY: secret,
});
const record = (): TaskDelegationCredentials => ({
  appId: 'app',
  openId: 'jiang',
  accessToken: 'old-access-secret',
  refreshToken: 'old-refresh-secret',
  scope: 'task:task:write offline_access',
  accessExpiresAt: Date.now() + 7200_000,
  refreshExpiresAt: Date.now() + 86400_000,
});
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe('Task delegation credentials', () => {
  it('encrypts secrets and rejects tampering, wrong keys and cross-environment reuse', () => {
    const value = record();
    const encrypted = sealTaskCredentials(value, secret, context);
    expect(encrypted).not.toContain(value.refreshToken);
    expect(openTaskCredentials(encrypted, secret, context)).toEqual(value);
    expect(() => openTaskCredentials(encrypted, secret, `production:${key}`)).toThrow();
    expect(() =>
      openTaskCredentials(encrypted, Buffer.alloc(32, 2).toString('base64'), context),
    ).toThrow();
    expect(() => openTaskCredentials(encrypted.slice(0, -5) + 'AAAA', secret, context)).toThrow();
  });
});

describe('TaskDelegationTokenService', () => {
  let ciphertext: string;
  let lease: string | undefined;
  const redis = { getEnvironment: () => 'test', get: jest.fn(), setNx: jest.fn(), eval: jest.fn() };
  const service = new TaskDelegationTokenService(config, redis as never);
  beforeEach(() => {
    jest.resetAllMocks();
    lease = undefined;
    ciphertext = sealTaskCredentials(record(), secret, context);
    redis.get.mockImplementation(async () => ciphertext);
    redis.setNx.mockImplementation(async (_key, owner) => {
      if (lease) return false;
      lease = owner;
      return true;
    });
    redis.eval.mockImplementation(async (_script, keys, args) => {
      if (lease !== args[0]) return 0;
      if (keys.length === 2) ciphertext = args[1];
      else lease = undefined;
      return 1;
    });
  });
  it('returns a valid token without rotating', async () => {
    await expect(service.getToken()).resolves.toBe('old-access-secret');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects wrong identities and missing configuration before any API call', async () => {
    ciphertext = sealTaskCredentials({ ...record(), openId: 'other' }, secret, context);
    await expect(service.getToken()).rejects.toThrow('identity');
    await expect(
      new TaskDelegationTokenService(new ConfigService({}), redis as never).getToken(),
    ).rejects.toThrow('not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  function expire() {
    ciphertext = sealTaskCredentials({ ...record(), accessExpiresAt: Date.now() }, secret, context);
  }
  function mockRefresh() {
    fetchMock.mockResolvedValueOnce(
      response({
        code: 0,
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 7200,
        refresh_token_expires_in: 86400,
        scope: 'task:task:write offline_access',
      }),
    );
    fetchMock.mockResolvedValueOnce(response({ code: 0, data: { open_id: 'jiang' } }));
  }
  it('persists rotated credentials before returning and releases the owned lease', async () => {
    expire();
    mockRefresh();
    await expect(service.getToken()).resolves.toBe('new-access');
    expect(openTaskCredentials(ciphertext, secret, context)).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
    });
    expect(lease).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await service.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('never replays an ambiguous refresh or leaks a provider error', async () => {
    expire();
    fetchMock.mockRejectedValue(new Error('old-refresh-secret'));
    await expect(service.getToken()).rejects.toThrow('refresh failed');
    await expect(service.getToken()).rejects.toThrow('outcome unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects concurrent rotation without sending another request', async () => {
    expire();
    redis.setNx.mockResolvedValue(false);
    await expect(service.getToken()).rejects.toThrow('in progress');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not rotate when the pending marker cannot be persisted', async () => {
    expire();
    redis.eval.mockRejectedValue(new Error('Redis down'));
    await expect(service.getToken()).rejects.toThrow('refresh failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does not return new tokens or overwrite another owner after losing the refresh lease', async () => {
    expire();
    mockRefresh();
    const save = redis.eval.getMockImplementation()!;
    let writes = 0;
    redis.eval.mockImplementation(async (script, keys, args) => {
      if (keys.length === 2 && ++writes === 2) lease = 'another-owner';
      return save(script, keys, args);
    });
    await expect(service.getToken()).rejects.toThrow('refresh failed');
    expect(openTaskCredentials(ciphertext, secret, context).refreshPending).toBe(true);
    expect(lease).toBe('another-owner');
    await expect(service.getToken()).rejects.toThrow('outcome unknown');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('requires reauthorization when the refresh grant has expired', async () => {
    ciphertext = sealTaskCredentials(
      { ...record(), accessExpiresAt: Date.now(), refreshExpiresAt: Date.now() - 1 },
      secret,
      context,
    );
    await expect(service.getToken()).rejects.toThrow('refresh failed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lease).toBeUndefined();
  });
  it('keeps the pending marker if rotated identity validation fails', async () => {
    expire();
    mockRefresh();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(
      response({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 7200,
        refresh_token_expires_in: 86400,
        scope: 'task:task:write offline_access',
      }),
    );
    fetchMock.mockResolvedValueOnce(response({ code: 0, data: { open_id: 'other' } }));
    await expect(service.getToken()).rejects.toThrow('refresh failed');
    expect(openTaskCredentials(ciphertext, secret, context).refreshPending).toBe(true);
  });
});

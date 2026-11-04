import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ApiConfigService } from '@infra/config/api-config.service';
import {
  GroupRouteCredentialsService,
  LEGACY_GROUP_CORP_ID,
} from '@wecom/message/credentials/group-route-credentials.service';

describe('GroupRouteCredentialsService', () => {
  let service: GroupRouteCredentialsService;
  let fetchSpy: jest.SpyInstance;
  let enterpriseToken: string | undefined;
  const endpoint = 'https://provider.example/api/v1/bot/getGroupBots';
  const scope = { corpId: LEGACY_GROUP_CORP_ID, accountId: 'account-a', groupId: 'group-a' };
  const callback = { ...scope, token: 'group-token-a', botId: 'bot-a' };
  const directory = () => ({
    errcode: 0,
    groups: [
      {
        id: 'group-a',
        token: 'group-token-a',
        bots: [{ id: 'bot-a', wxid: 'account-a', corpId: 'corp-a' }],
      },
      {
        id: 'group-b',
        token: 'group-token-b',
        bots: [{ id: 'bot-b', wxid: 'account-b', corpId: 'corp-b' }],
      },
    ],
  });
  const respond = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

  beforeEach(async () => {
    enterpriseToken = 'enterprise-credential';
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => respond(directory()));
    const module = await Test.createTestingModule({
      providers: [
        GroupRouteCredentialsService,
        { provide: ConfigService, useValue: { get: () => enterpriseToken } },
        {
          provide: ApiConfigService,
          useValue: { endpoints: { bot: { groupBots: () => endpoint } } },
        },
      ],
    }).compile();
    service = module.get(GroupRouteCredentialsService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('authenticates a legacy callback against the current server-side group and account', async () => {
    expect(await service.verifyCallback(callback)).toEqual({
      groupId: 'group-a',
      corpIds: [LEGACY_GROUP_CORP_ID, 'corp-a'],
    });
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).searchParams.get('token')).toBe(enterpriseToken);
    expect(options).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts the trusted account corporation and returns no credential in callback identity', async () => {
    const result = await service.verifyCallback({ ...callback, corpId: 'corp-a' });
    expect(result).toEqual({ groupId: 'group-a', corpIds: [LEGACY_GROUP_CORP_ID, 'corp-a'] });
    expect(JSON.stringify(result)).not.toContain('group-token');
    expect(JSON.stringify(result)).not.toContain('enterprise-credential');
  });

  it('derives the group for an inbound callback without trusting a body groupId', async () => {
    expect(await service.verifyCallback({ ...callback, groupId: undefined })).toEqual({
      groupId: 'group-a',
      corpIds: [LEGACY_GROUP_CORP_ID, 'corp-a'],
    });
  });

  it.each([
    { token: 'forged-token' },
    { token: 'group-token-b' },
    { token: ' group-token-a ' },
    { accountId: 'account-b' },
    { corpId: 'corp-b' },
    { groupId: 'group-b' },
    { groupId: '' },
    { botId: 'bot-b' },
    { accountId: 'absent-account' },
  ])('rejects forged or mismatched callback identity %j', async (change) => {
    expect(await service.verifyCallback({ ...callback, ...change })).toBeNull();
  });

  it.each([{ corpId: '' }, { accountId: '' }, { token: '' }])(
    'does not query the directory for incomplete callback identity %j',
    async (change) => {
      expect(await service.verifyCallback({ ...callback, ...change })).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('resolves recovery only for the original group/account/corporation', async () => {
    expect(await service.resolveForRecovery(scope)).toEqual({
      token: 'group-token-a',
      groupId: 'group-a',
    });
    expect(await service.resolveForRecovery({ ...scope, corpId: 'corp-a' })).toEqual({
      token: 'group-token-a',
      groupId: 'group-a',
    });
    expect(await service.resolveForRecovery({ ...scope, corpId: 'corp-b' })).toBeNull();
    expect(await service.resolveForRecovery({ ...scope, groupId: 'group-b' })).toBeNull();
  });

  it("keeps old plans without a frozen group manual, without guessing today's group", async () => {
    expect(await service.resolveForRecovery({ ...scope, groupId: undefined })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not recover a frozen plan after the account has moved groups', async () => {
    const moved = directory();
    moved.groups[1].bots.push(moved.groups[0].bots[0]);
    moved.groups[0].bots = [];
    fetchSpy.mockResolvedValueOnce(respond(moved));
    expect(await service.resolveForRecovery(scope)).toBeNull();
  });

  it('does not retain authorization after token rotation or directory removal', async () => {
    expect(await service.verifyCallback(callback)).not.toBeNull();
    const rotated = directory();
    rotated.groups[0].token = 'new-group-token';
    fetchSpy.mockResolvedValueOnce(respond(rotated));
    expect(await service.verifyCallback(callback)).toBeNull();
    fetchSpy.mockResolvedValueOnce(respond(rotated));
    expect(await service.resolveForRecovery(scope)).toEqual({
      token: 'new-group-token',
      groupId: 'group-a',
    });
    fetchSpy.mockResolvedValueOnce(respond({ errcode: 0, groups: [] }));
    expect(await service.resolveForRecovery(scope)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it.each(['token', 'corpId', 'botId'] as const)(
    'rejects a callback when the authoritative %s is unavailable',
    async (field) => {
      const missing = directory();
      if (field === 'token') missing.groups[0].token = '';
      else if (field === 'corpId') missing.groups[0].bots[0].corpId = '';
      else missing.groups[0].bots[0].id = '';
      fetchSpy.mockResolvedValueOnce(respond(missing));
      expect(await service.verifyCallback(callback)).toBeNull();
    },
  );

  it('rejects a directory pretending the legacy namespace is an authoritative corporation', async () => {
    const invalid = directory();
    invalid.groups[0].bots[0].corpId = LEGACY_GROUP_CORP_ID;
    fetchSpy.mockResolvedValueOnce(respond(invalid));
    expect(await service.verifyCallback(callback)).toBeNull();
  });

  it('shares only an in-flight directory request, not its completed response', async () => {
    let finish!: (response: Response) => void;
    fetchSpy.mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)));
    const first = service.verifyCallback(callback);
    const concurrent = service.resolveForRecovery(scope);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    finish(respond(directory()));
    await expect(first).resolves.toEqual({
      groupId: 'group-a',
      corpIds: [LEGACY_GROUP_CORP_ID, 'corp-a'],
    });
    await expect(concurrent).resolves.toEqual({ token: 'group-token-a', groupId: 'group-a' });
    await service.verifyCallback(callback);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not reuse an in-flight request when the enterprise credential changes', async () => {
    let finish!: (response: Response) => void;
    fetchSpy.mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)));
    const previous = service.verifyCallback(callback);
    enterpriseToken = 'rotated-enterprise-credential';
    const current = service.verifyCallback(callback);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new URL(fetchSpy.mock.calls[1][0]).searchParams.get('token')).toBe(enterpriseToken);
    await current;
    finish(respond(directory()));
    await previous;
  });

  it('accepts supported nested data envelopes without exposing credentials', async () => {
    fetchSpy.mockResolvedValueOnce(respond({ errcode: 0, data: { data: directory() } }));
    expect(await service.verifyCallback(callback)).not.toBeNull();
  });

  it.each([
    null,
    [],
    { groups: 'not-an-array' },
    { errcode: 1, groups: [] },
    { errcode: 1, data: directory() },
    { data: { errcode: 1, groups: [] } },
    { groups: [{ id: 'group-a' }] },
    { groups: [{ id: '', bots: [] }] },
    { groups: [{ id: 'group-a', bots: [{ id: 'bot-a', corpId: 'corp-a' }] }] },
  ])(
    'fails closed with a sanitized error for malformed or failed directories',
    async (response) => {
      fetchSpy.mockResolvedValueOnce(respond(response));
      await expect(service.verifyCallback(callback)).rejects.toThrow(
        'group_route_credentials_unavailable',
      );
    },
  );

  it.each(['group', 'account'] as const)('rejects duplicate %s identities', async (kind) => {
    const duplicated = directory();
    if (kind === 'group') duplicated.groups.push({ ...duplicated.groups[0], bots: [] });
    else duplicated.groups[1].bots.push({ ...duplicated.groups[0].bots[0] });
    fetchSpy.mockResolvedValueOnce(respond(duplicated));
    await expect(service.verifyCallback(callback)).rejects.toThrow(
      'group_route_credentials_unavailable',
    );
  });

  it('does not use the previous valid directory after a network failure', async () => {
    expect(await service.verifyCallback(callback)).not.toBeNull();
    fetchSpy.mockRejectedValueOnce(new Error('upstream unavailable'));
    await expect(service.resolveForRecovery(scope)).rejects.toThrow(
      'group_route_credentials_unavailable',
    );
  });

  it('does not fetch without a configured enterprise credential', async () => {
    enterpriseToken = undefined;
    await expect(service.verifyCallback(callback)).rejects.toThrow(
      'group_route_credentials_unavailable',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not read or expose the body of an HTTP failure', async () => {
    const json = jest.fn();
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 403, json } as unknown as Response);
    await expect(service.verifyCallback(callback)).rejects.toThrow(
      'group_route_credentials_unavailable',
    );
    expect(json).not.toHaveBeenCalled();
  });

  it('never logs or forwards secret-bearing upstream errors', async () => {
    const logs = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((method) =>
      jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined),
    );
    const error = Object.assign(new Error('enterprise-credential group-token-a'), {
      url: endpoint + '?token=enterprise-credential',
      response: directory(),
    });
    fetchSpy.mockRejectedValueOnce(error);
    const result = await service.verifyCallback(callback).catch((caught: unknown) => caught);
    expect(result).toEqual(new Error('group_route_credentials_unavailable'));
    expect(result).not.toHaveProperty('cause');
    expect(result).not.toHaveProperty('url');
    expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain('credential');
    expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain('group-token-a');
  });

  it('aborts a stalled directory request without leaking the request URL', async () => {
    fetchSpy.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('secret-url')));
        }),
    );
    await expect(service.verifyCallback(callback)).rejects.toThrow(
      'group_route_credentials_unavailable',
    );
  }, 7000);
});

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { RedisService } from '@infra/redis/redis.service';
import { fetchWithTimeout } from '@infra/utils/fetch-timeout.util';
import {
  openTaskCredentials,
  sealTaskCredentials,
  taskDelegationKey,
  type TaskDelegationCredentials,
} from './task-delegation-credentials';

const LOCK_SECONDS = 90;
const SAVE_WHILE_LOCKED = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[2], ARGV[2]); return 1 end; return 0`;
const UNLOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0`;

/** User authorization used only for task delegation; never replaces the tenant API token. */
@Injectable()
export class TaskDelegationTokenService {
  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  async getToken(): Promise<string> {
    const appId = this.config.get<string>('FEISHU_APP_ID')?.trim();
    const openId = this.config.get<string>('FEISHU_TASK_DELEGATOR_OPEN_ID')?.trim();
    const secret = this.config.get<string>('FEISHU_TASK_DELEGATOR_ENCRYPTION_KEY');
    if (!appId || !openId || !secret)
      throw new Error('Task delegation authorization is not configured');
    const key = taskDelegationKey(appId, openId);
    const context = `${this.redis.getEnvironment()}:${key}`;
    const read = async (): Promise<TaskDelegationCredentials> => {
      const ciphertext = await this.redis.get<string>(key);
      if (!ciphertext) throw new Error('Task delegation authorization is missing');
      const record = openTaskCredentials(ciphertext, secret, context);
      if (
        record.appId !== appId ||
        record.openId !== openId ||
        !['task:task:write', 'offline_access'].every((s) => record.scope.split(/\s+/).includes(s))
      ) {
        throw new Error('Task delegation identity or permissions mismatch');
      }
      if (record.refreshPending)
        throw new Error('Task delegation refresh outcome unknown; reauthorization required');
      return record;
    };
    let record = await read();
    if (record.accessExpiresAt > Date.now() + 300_000) return record.accessToken;
    const lock = `${key}:refresh-lock`;
    const owner = randomUUID();
    if (!(await this.redis.setNx(lock, owner, LOCK_SECONDS)))
      throw new Error('Task delegation refresh in progress; retry later');
    const save = async (value: TaskDelegationCredentials) => {
      const result = await this.redis.eval(
        SAVE_WHILE_LOCKED,
        [lock, key],
        [owner, sealTaskCredentials(value, secret, context)],
      );
      if (Number(result) !== 1)
        throw new Error('Task delegation refresh lease lost; reconciliation required');
    };
    try {
      record = await read();
      if (record.accessExpiresAt > Date.now() + 300_000) return record.accessToken;
      if (record.refreshExpiresAt <= Date.now())
        throw new Error('Task delegation authorization expired; reauthorization required');
      const clientSecret = this.config.get<string>('FEISHU_APP_SECRET');
      if (!clientSecret) throw new Error('Task delegation application secret missing');
      await save({ ...record, refreshPending: true });
      // Do not retry this rotation: a timeout may hide consumption of the refresh token.
      const startedAt = Date.now();
      const response = await fetchWithTimeout(
        'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          timeoutMs: 10_000,
          signal: AbortSignal.timeout(12_000),
          body: JSON.stringify({
            grant_type: 'refresh_token',
            client_id: appId,
            client_secret: clientSecret,
            refresh_token: record.refreshToken,
          }),
        },
      );
      const body = (await response.json()) as Record<string, unknown>;
      if (
        !response.ok ||
        (body.code !== undefined && body.code !== 0) ||
        typeof body.access_token !== 'string' ||
        !body.access_token ||
        typeof body.refresh_token !== 'string' ||
        !body.refresh_token ||
        typeof body.expires_in !== 'number' ||
        body.expires_in <= 0 ||
        typeof body.refresh_token_expires_in !== 'number' ||
        body.refresh_token_expires_in <= 0 ||
        typeof body.scope !== 'string' ||
        !['task:task:write', 'offline_access'].every((s) =>
          (body.scope as string).split(/\s+/).includes(s),
        )
      ) {
        throw new Error('Task delegation refresh rejected; reauthorization required');
      }
      const identityResponse = await fetchWithTimeout(
        'https://open.feishu.cn/open-apis/authen/v1/user_info',
        {
          headers: { Authorization: `Bearer ${body.access_token}` },
          timeoutMs: 10_000,
          signal: AbortSignal.timeout(12_000),
        },
      );
      const identity = (await identityResponse.json()) as {
        code?: number;
        data?: { open_id?: string };
      };
      if (!identityResponse.ok || identity.code !== 0 || identity.data?.open_id !== openId) {
        throw new Error('Task delegation refreshed identity could not be verified');
      }
      const next: TaskDelegationCredentials = {
        appId,
        openId,
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        accessExpiresAt: startedAt + body.expires_in * 1000,
        refreshExpiresAt: startedAt + body.refresh_token_expires_in * 1000,
        scope: body.scope,
      };
      await save(next);
      return next.accessToken;
    } catch {
      // Never propagate provider bodies or exceptions containing credentials into job logs.
      throw new Error('Task delegation refresh failed; inspect authorization before retrying');
    } finally {
      await this.redis.eval(UNLOCK, [lock], [owner]).catch(() => undefined);
    }
  }
}

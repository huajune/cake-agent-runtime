#!/usr/bin/env node
/** Import an explicitly authorized user credential file; never prints secrets. */
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('node:fs');
const { parseEnv } = require('node:util');
const { Redis } = require('@upstash/redis');
const {
  sealTaskCredentials,
  openTaskCredentials,
  taskDelegationKey,
} = require('../src/infra/feishu/services/task-delegation-credentials');

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const envFile = option('--env-file'),
    credentialFile = option('--credentials-file');
  const environment = option('--environment'),
    action = option('--action');
  if (
    !envFile ||
    !environment ||
    !['check', 'install'].includes(action) ||
    (action === 'install' && !credentialFile)
  ) {
    throw Error(
      'Usage: --env-file PATH --environment production|development --action check|install [--credentials-file PATH]',
    );
  }
  const env = parseEnv(fs.readFileSync(envFile, 'utf8'));
  const configuredEnvironment = env.RUNTIME_ENV || env.NODE_ENV;
  if (configuredEnvironment && configuredEnvironment !== environment)
    throw Error('Environment mismatch');
  const appId = env.FEISHU_APP_ID,
    openId = env.FEISHU_TASK_DELEGATOR_OPEN_ID,
    secret = env.FEISHU_TASK_DELEGATOR_ENCRYPTION_KEY;
  if (!appId || !openId || !secret || !env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN)
    throw Error('Required delegation configuration missing');
  const redis = new Redis({ url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN });
  const key = `${environment}:${taskDelegationKey(appId, openId)}`;
  if (action === 'install') {
    if (await redis.exists(key))
      throw Error('Credentials already installed; do not overwrite rotated authorization');
    const source = JSON.parse(fs.readFileSync(credentialFile, 'utf8'));
    if (
      source.appId !== appId ||
      source.expectedOpenId !== openId ||
      !source.refresh_token ||
      !Number.isFinite(source.expires_in) ||
      !Number.isFinite(source.refresh_token_expires_in) ||
      !Number.isFinite(source.obtainedAt) ||
      source.obtainedAt + source.expires_in * 1000 <= Date.now() + 60_000 ||
      !['task:task:write', 'offline_access'].every((s) => source.scope?.split(/\s+/).includes(s))
    )
      throw Error('Source credentials invalid or expired');
    const response = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { Authorization: `Bearer ${source.access_token}` },
      signal: AbortSignal.timeout(12000),
    });
    const identity = await response.json();
    if (!response.ok || identity.code !== 0 || identity.data?.open_id !== openId)
      throw Error('Live delegator identity not verified');
    const record = {
      appId,
      openId,
      accessToken: source.access_token,
      refreshToken: source.refresh_token,
      accessExpiresAt: source.obtainedAt + source.expires_in * 1000,
      refreshExpiresAt: source.obtainedAt + source.refresh_token_expires_in * 1000,
      scope: source.scope,
    };
    const saved = await redis.set(key, sealTaskCredentials(record, secret, key), { nx: true });
    if (saved !== 'OK') throw Error('Concurrent installation detected; nothing overwritten');
  }
  const ciphertext = await redis.get(key);
  if (typeof ciphertext !== 'string') throw Error('Stored credentials missing');
  const record = openTaskCredentials(ciphertext, secret, key);
  if (record.appId !== appId || record.openId !== openId) throw Error('Stored delegator mismatch');
  console.log(
    JSON.stringify({
      environment,
      installed: true,
      encrypted: true,
      identityMatches: true,
      refreshPending: record.refreshPending === true,
      accessExpired: record.accessExpiresAt <= Date.now(),
      refreshExpired: record.refreshExpiresAt <= Date.now(),
    }),
  );
}
main().catch(() => {
  console.error(
    'Task delegation configuration check/import failed; no credentials were printed. Verify explicit environment, identity, expiry and existing installation.',
  );
  process.exitCode = 1;
});

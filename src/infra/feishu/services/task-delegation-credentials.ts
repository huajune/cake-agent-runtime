import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface TaskDelegationCredentials {
  appId: string;
  openId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  scope: string;
  /** Rotation may consume the old refresh token, so an ambiguous result must not be replayed. */
  refreshPending?: boolean;
}

export function taskDelegationKey(appId: string, openId: string): string {
  return `feishu:task-delegator:${appId}:${openId}`;
}

function encryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('Task delegation encryption key must contain 32 bytes');
  return key;
}

export function sealTaskCredentials(
  value: TaskDelegationCredentials,
  secret: string,
  context: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    data.toString('base64'),
  ].join('.');
}

export function openTaskCredentials(
  value: string,
  secret: string,
  context: string,
): TaskDelegationCredentials {
  try {
    const [version, iv, tag, data, extra] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !data || extra) throw new Error();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(secret),
      Buffer.from(iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const parsed: unknown = JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
        'utf8',
      ),
    );
    if (!parsed || typeof parsed !== 'object') throw new Error();
    const record = parsed as Record<string, unknown>;
    for (const field of ['appId', 'openId', 'accessToken', 'refreshToken', 'scope']) {
      if (typeof record[field] !== 'string' || !record[field]) throw new Error();
    }
    for (const field of ['accessExpiresAt', 'refreshExpiresAt']) {
      if (typeof record[field] !== 'number' || !Number.isFinite(record[field])) throw new Error();
    }
    if (record.refreshPending !== undefined && typeof record.refreshPending !== 'boolean')
      throw new Error();
    return parsed as TaskDelegationCredentials;
  } catch {
    throw new Error('Task delegation credentials cannot be decrypted or validated');
  }
}

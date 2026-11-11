import { createHash } from 'crypto';
import type { ActionIntent } from './action-execution.types';

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => {
        if (/^(token|accessToken|authorization|password|secret|apiKey)$/i.test(key))
          throw new Error('Credentials must not enter action records');
        return `${JSON.stringify(key)}:${canonical(entry)}`;
      })
      .join(',')}}`;
  }
  throw new Error('Action data must be JSON serializable');
}

export function actionDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function identifyAction(intent: ActionIntent): {
  actionId: string;
  requestId: string;
  payloadHash: string;
} {
  for (const value of [
    intent.corpId,
    intent.accountId,
    intent.chatId,
    intent.logicalTurnId,
    intent.intentId,
    intent.kind,
    intent.target,
  ]) {
    if (!value?.trim()) throw new Error('Action identity is incomplete');
  }
  if (!Number.isFinite(Date.parse(intent.occurredAt)))
    throw new Error('Action input time is required');
  const actionId = actionDigest([
    intent.corpId,
    intent.accountId,
    intent.intentId,
    intent.kind,
    intent.target,
  ]);
  canonical(intent.recovery ?? {});
  return {
    actionId,
    requestId: `cake_${actionId.slice(0, 48)}`,
    payloadHash: actionDigest(intent.parameters),
  };
}

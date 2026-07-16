export type HandoffIdempotencyScope = 'handoff' | 'output_guard';

/**
 * 统一生成 Runner 人工介入出口的幂等键。
 *
 * turnId 必须由调用方提供同一逻辑回合内稳定的标识：生产入站使用消息/批次 ID，
 * 主动触达使用调度回合 ID。这里仅统一格式并拒绝空值，不擅自生成不稳定标识。
 */
export function buildHandoffIdempotencyKey(input: {
  chatId: string;
  turnId: string | number;
  scope?: HandoffIdempotencyScope;
}): string {
  const chatId = input.chatId.trim();
  const turnId = String(input.turnId).trim();
  if (!chatId) throw new Error('handoff idempotency key 缺少 chatId');
  if (!turnId) throw new Error('handoff idempotency key 缺少 turnId');

  const suffix = input.scope === 'output_guard' ? ':output_guard' : '';
  return `${chatId}:handoff:${turnId}${suffix}`;
}

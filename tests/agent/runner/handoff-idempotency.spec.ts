import { buildHandoffIdempotencyKey } from '@agent/runner/handoff-idempotency';

describe('buildHandoffIdempotencyKey', () => {
  it('builds the canonical handoff key', () => {
    expect(buildHandoffIdempotencyKey({ chatId: 'chat-1', turnId: 'msg-1' })).toBe(
      'chat-1:handoff:msg-1',
    );
  });

  it('adds a discriminator for output guard handoffs', () => {
    expect(
      buildHandoffIdempotencyKey({
        chatId: 'chat-1',
        turnId: 'msg-1',
        scope: 'output_guard',
      }),
    ).toBe('chat-1:handoff:msg-1:output_guard');
  });

  it('rejects an empty stable identity', () => {
    expect(() => buildHandoffIdempotencyKey({ chatId: '', turnId: 'msg-1' })).toThrow(
      '缺少 chatId',
    );
    expect(() => buildHandoffIdempotencyKey({ chatId: 'chat-1', turnId: '' })).toThrow(
      '缺少 turnId',
    );
  });
});

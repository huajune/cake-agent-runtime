import { conversationProcessingLeaseKey } from '@infra/queue/lease-keys';
import { RedisKeyBuilder } from '@wecom/message/runtime/redis-key.util';

it('shares the existing conversation lock bytes across background and foreground callers', () => {
  expect(conversationProcessingLeaseKey('chat:123')).toBe('wecom:message:lock:chat:123');
  expect(RedisKeyBuilder.lock('chat:123')).toBe(conversationProcessingLeaseKey('chat:123'));
});

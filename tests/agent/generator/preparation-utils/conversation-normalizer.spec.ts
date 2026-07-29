import { CallerKind } from '@/enums/agent.enum';
import { normalizeConversation } from '@agent/generator/preparation-utils/conversation-normalizer';

describe('normalizeConversation', () => {
  it('downgrades system-role history messages to user context (AI SDK v7 rejects system in messages)', () => {
    const result = normalizeConversation({
      callerKind: CallerKind.DEBUG,
      memoryWindow: [],
      passedMessages: [
        { role: 'system', content: '你是测试注入的系统上下文' },
        { role: 'user', content: '你好' },
      ],
      enableVision: false,
    });

    expect(result).toEqual([
      { role: 'user', content: '你是测试注入的系统上下文' },
      { role: 'user', content: '你好' },
    ]);
    expect(result.some((message) => message.role === 'system')).toBe(false);
  });

  it('keeps user/assistant roles untouched', () => {
    const result = normalizeConversation({
      callerKind: CallerKind.DEBUG,
      memoryWindow: [],
      passedMessages: [
        { role: 'user', content: '在吗' },
        { role: 'assistant', content: '在的，想找什么工作？' },
      ],
      enableVision: false,
    });

    expect(result).toEqual([
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '在的，想找什么工作？' },
    ]);
  });
});

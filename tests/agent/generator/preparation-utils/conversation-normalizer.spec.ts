import { CallerKind } from '@/enums/agent.enum';
import {
  normalizeConversation,
  normalizeConversationWithCorpus,
} from '@agent/generator/preparation-utils/conversation-normalizer';

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

  it('keeps semantic domains when SDK transport downgrades an internal system block to user', () => {
    const result = normalizeConversationWithCorpus({
      callerKind: CallerKind.DEBUG,
      memoryWindow: [],
      passedMessages: [
        {
          role: 'system',
          content: '[引用 招聘经理：旧模板]\n姓名：王小明\n[消息发送时间：2026-08-13 10:24:31]',
        },
        { role: 'user', content: '[图片消息]' },
        { role: 'user', content: '我叫王玥\n[消息发送时间：2026-08-13 10:24:32]' },
      ],
      enableVision: false,
    });

    expect(result.messages[0]).toMatchObject({ role: 'user' });
    expect(result.corpusBlocks).toEqual([
      expect.objectContaining({ id: 'conversation-0', domain: 'teaching', role: 'system' }),
      expect.objectContaining({ id: 'conversation-1', domain: 'evidence', role: 'user' }),
      expect.objectContaining({ id: 'conversation-2', domain: 'evidence', role: 'user' }),
    ]);
  });
});

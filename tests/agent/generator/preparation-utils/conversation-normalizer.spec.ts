import { CallerKind } from '@/enums/agent.enum';
import {
  normalizeConversation,
  normalizeConversationWithCorpus,
} from '@agent/generator/preparation/conversation-normalizer';
import { StorageMessageType } from '@enums/storage-message.enum';

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

  it('保留撤回消息的结构化来源标记，避免把旧文本当仍然有效的候选人证据', () => {
    const result = normalizeConversation({
      callerKind: CallerKind.DEBUG,
      memoryWindow: [],
      passedMessages: [
        {
          role: 'user',
          content: '[引用 招聘经理：在哪里]\n我在深圳\n[消息发送时间：2026-08-13 10:24:31]',
          messageType: StorageMessageType.REVOKE,
        },
        { role: 'user', content: '[图片消息]' },
      ],
      enableVision: false,
    });

    expect(result[0]).toMatchObject({ role: 'user' });
    expect(result[0].content).toContain('（该消息已撤回）');
  });
});

describe('normalizeConversationWithCorpus · 多模态图片注入', () => {
  // 这两例原本挂在 preparation.service.spec 的整链路上，随备料层拆分被删；
  // injectImageParts 的落位不变量没有别处守着，这里按纯函数口径补回。
  it('injects top-level images into the last user message when vision is enabled', () => {
    const { messages } = normalizeConversationWithCorpus({
      callerKind: CallerKind.WECOM,
      memoryWindow: [{ role: 'user', content: '帮我看看这张图' }],
      passedMessages: [{ role: 'user', content: '帮我看看这张图' }],
      enableVision: true,
      imageUrls: ['https://example.com/test.png'],
      imageMessageIds: ['img-1'],
    });

    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '[图片 messageId=img-1]' },
          { type: 'image', image: new URL('https://example.com/test.png') },
          { type: 'text', text: '帮我看看这张图' },
        ],
      },
    ]);
  });

  it('injects images at the [图片消息] placeholder position, not at the end of the turn', () => {
    const { messages } = normalizeConversationWithCorpus({
      callerKind: CallerKind.WECOM,
      memoryWindow: [
        { role: 'assistant', content: '想找什么岗位' },
        { role: 'user', content: '你好啊' },
        { role: 'user', content: '[图片消息]' },
        { role: 'user', content: '我是看信息来的' },
      ],
      passedMessages: [{ role: 'user', content: '你好啊\n[图片消息]\n我是看信息来的' }],
      enableVision: true,
      imageUrls: ['https://example.com/job.png'],
      imageMessageIds: ['img-job-1'],
    });

    // 图片必须落在占位符那一条上：接在整轮末尾会把图片接到「我是看信息来的」下面，
    // 模型据此把图片内容当成后一句的补充。
    expect(messages).toEqual([
      { role: 'assistant', content: '想找什么岗位' },
      { role: 'user', content: '你好啊' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[图片 messageId=img-job-1]' },
          { type: 'image', image: new URL('https://example.com/job.png') },
          { type: 'text', text: '[图片消息]' },
        ],
      },
      { role: 'user', content: '我是看信息来的' },
    ]);
  });

  it('leaves the turn untouched when vision is disabled', () => {
    const { messages } = normalizeConversationWithCorpus({
      callerKind: CallerKind.WECOM,
      memoryWindow: [{ role: 'user', content: '[图片消息]' }],
      passedMessages: [{ role: 'user', content: '[图片消息]' }],
      enableVision: false,
      imageUrls: ['https://example.com/test.png'],
      imageMessageIds: ['img-1'],
    });

    expect(messages).toEqual([{ role: 'user', content: '[图片消息]' }]);
  });
});

import { CallerKind } from '@/enums/agent.enum';
import {
  HUMAN_AGENT_MESSAGE_MARKER,
  normalizeConversation,
  normalizeConversationWithCorpus,
  resolveHumanTakeoverActive,
} from '@agent/generator/preparation/conversation-normalizer';
import { StorageMessageSource, StorageMessageType } from '@enums/storage-message.enum';

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

describe('真人接管态（resolveHumanTakeoverActive / humanTakeoverActive）', () => {
  const human = (content: string) => ({
    role: 'assistant',
    content,
    source: StorageMessageSource.MOBILE_PUSH,
    messageType: StorageMessageType.TEXT,
    isSelf: true,
  });
  const agent = (content: string) => ({
    role: 'assistant',
    content,
    source: StorageMessageSource.API_SEND,
    messageType: StorageMessageType.TEXT,
    isSelf: true,
  });
  const user = (content: string) => ({ role: 'user', content });

  it('候选人当前消息块之前最近一条经理侧消息是真人手动发送 → active', () => {
    expect(
      resolveHumanTakeoverActive([agent('岗位在这'), human('有餐饮经验吗'), user('有的')]),
    ).toBe(true);
    // 合并请求：末尾多条 user 仍只看其前最近一条 assistant
    expect(resolveHumanTakeoverActive([human('明天面试有空吗'), user('有'), user('几点')])).toBe(
      true,
    );
  });

  // chat 6a4dbf4bce406a6aee3137e4：真人只发过开场"你好"，之后全是 Agent 回复，候选人问
  // "前厅还是后厨"是发给 Agent 的；历史更早的真人标记不构成让位理由。
  it('Agent 已经回复过之后，更早的真人消息不再构成 active', () => {
    expect(
      resolveHumanTakeoverActive([
        human('你好'),
        user('你好'),
        agent('你平时在哪个区域呀'),
        user('延吉'),
        agent('固定排班制，每月至少上岗80小时'),
        user('前厅还是后厨'),
      ]),
    ).toBe(false);
  });

  it('没有任何经理侧消息、或最近一条是复聊/群邀请等非真人文本 → 不 active', () => {
    expect(resolveHumanTakeoverActive([user('你好')])).toBe(false);
    expect(resolveHumanTakeoverActive([])).toBe(false);
    expect(
      resolveHumanTakeoverActive([
        { ...human('还在找工作吗'), payloadSource: 'reengagement' },
        user('在找'),
      ]),
    ).toBe(false);
    expect(
      resolveHumanTakeoverActive([
        { ...human('邀请你加入群聊'), messageType: StorageMessageType.ROOM_INVITE },
        user('好'),
      ]),
    ).toBe(false);
  });

  it('normalizeConversationWithCorpus 随 messages 同批输出 humanTakeoverActive，并只给真人消息挂来源标记', () => {
    const result = normalizeConversationWithCorpus({
      callerKind: CallerKind.WECOM,
      memoryWindow: [agent('岗位在这'), human('有餐饮经验吗'), user('有的')],
      passedMessages: [user('有的')],
      enableVision: false,
    });

    expect(result.humanTakeoverActive).toBe(true);
    expect(result.messages[0].content).toBe('岗位在这');
    expect(result.messages[1].content).toBe(`${HUMAN_AGENT_MESSAGE_MARKER}\n有餐饮经验吗`);
    // 标记只标来源与保密纪律；沉默条件唯一住所是 skip_reply description
    expect(HUMAN_AGENT_MESSAGE_MARKER).toMatch(/^\[内部来源标记：/);
    expect(HUMAN_AGENT_MESSAGE_MARKER).not.toContain('skip_reply');
    expect(HUMAN_AGENT_MESSAGE_MARKER).not.toContain('本轮不回复');

    const inactive = normalizeConversationWithCorpus({
      callerKind: CallerKind.WECOM,
      memoryWindow: [human('你好'), user('你好'), agent('在哪个区域'), user('前厅还是后厨')],
      passedMessages: [user('前厅还是后厨')],
      enableVision: false,
    });
    expect(inactive.humanTakeoverActive).toBe(false);
  });
});

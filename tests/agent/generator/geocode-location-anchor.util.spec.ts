import { resolveGeocodeLocationAnchor } from '@agent/generator/geocode-location-anchor.util';
import { extractHighConfidenceFacts } from '@memory/facts/high-confidence-facts';
import { StorageMessageSource, StorageMessageType } from '@enums/storage-message.enum';

describe('resolveGeocodeLocationAnchor', () => {
  const humanMessage = (content: string) => ({
    role: 'assistant',
    content,
    source: StorageMessageSource.MOBILE_PUSH,
    messageType: StorageMessageType.TEXT,
    isSelf: true,
  });

  it('从紧邻人工 assistant turn 为“附近”回指提取上海嘉定锚点', () => {
    const result = resolveGeocodeLocationAnchor({
      currentUserMessage: '附近的呢',
      shortTermMessages: [
        { role: 'user', content: '同济店' },
        humanMessage('上海嘉定同济园是吧，我看下\n[消息发送时间：2026-07-09 18:38 星期四]'),
        humanMessage('这个店目前只有夜宵岗'),
        { role: 'user', content: '附近的呢' },
      ],
      currentFacts: null,
      sessionFacts: null,
    });

    expect(result).toMatchObject({
      city: '上海',
      districts: ['嘉定'],
      source: 'human_agent',
      referenceText: '上海嘉定同济园是吧，我看下',
    });
  });

  it('不把 API_SEND assistant 当人工锚点，也不跨过它向前捞旧人工消息', () => {
    const result = resolveGeocodeLocationAnchor({
      currentUserMessage: '附近的呢',
      shortTermMessages: [
        humanMessage('上海嘉定同济园是吧'),
        {
          role: 'assistant',
          content: '我帮你看下',
          source: StorageMessageSource.API_SEND,
          messageType: StorageMessageType.TEXT,
          isSelf: true,
        },
        { role: 'user', content: '附近的呢' },
      ],
      currentFacts: null,
      sessionFacts: null,
    });

    expect(result).toBeUndefined();
  });

  it('排除历史上被错标成 MOBILE_PUSH 的 reengagement 消息', () => {
    const result = resolveGeocodeLocationAnchor({
      currentUserMessage: '这边附近呢',
      shortTermMessages: [
        {
          ...humanMessage('上海嘉定这边还有岗位'),
          payloadSource: 'reengagement',
        },
        { role: 'user', content: '这边附近呢' },
      ],
      currentFacts: null,
      sessionFacts: null,
    });

    expect(result).toBeUndefined();
  });

  it('当前候选人明示的新区县优先于旧人工锚点', () => {
    const currentFacts = extractHighConfidenceFacts(['杨浦附近呢'], []);
    const result = resolveGeocodeLocationAnchor({
      currentUserMessage: '杨浦附近呢',
      shortTermMessages: [
        humanMessage('上海嘉定同济园是吧'),
        { role: 'user', content: '杨浦附近呢' },
      ],
      currentFacts,
      sessionFacts: null,
    });

    expect(result).toMatchObject({
      city: '上海',
      districts: ['杨浦'],
      source: 'current_user',
    });
  });

  it('非回指消息不使用旧人工或 session 锚点', () => {
    const result = resolveGeocodeLocationAnchor({
      currentUserMessage: '我想看看五角场',
      shortTermMessages: [
        humanMessage('上海嘉定同济园是吧'),
        { role: 'user', content: '我想看看五角场' },
      ],
      currentFacts: null,
      sessionFacts: {
        interview_info: {},
        preferences: {
          city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
          district: ['嘉定'],
          location: ['同济店'],
        },
        reasoning: '',
      } as never,
    });

    expect(result).toBeUndefined();
  });
});

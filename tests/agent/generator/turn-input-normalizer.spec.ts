import { normalizeTurnInput } from '@agent/generator/preparation/conversation-normalizer';

describe('normalizeTurnInput', () => {
  it('treats consecutive trailing user messages as one turn', () => {
    const result = normalizeTurnInput(
      {
        messages: [
          { role: 'user', content: '历史问题' },
          { role: 'assistant', content: '历史回复' },
          { role: 'user', content: '我只做兼职' },
          { role: 'user', content: '每周最多两天' },
        ],
      },
      1_000,
    );

    expect(result.currentTurnTexts).toEqual(['我只做兼职', '每周最多两天']);
    expect(result.currentUserMessage).toBe('我只做兼职\n每周最多两天');
    expect(result.laborFormIntent).toEqual(expect.objectContaining({ kind: 'set', value: '兼职' }));
  });

  it('uses the same truncated message set for every downstream view', () => {
    const result = normalizeTurnInput(
      {
        messages: [
          { role: 'user', content: '很长的历史消息' },
          { role: 'assistant', content: '旧回复' },
          { role: 'user', content: '当前消息' },
        ],
      },
      4,
    );

    expect(result.truncatedMessages).toEqual([{ role: 'user', content: '当前消息' }]);
    expect(result.currentTurnTexts).toEqual(['当前消息']);
    expect(result.currentUserMessage).toBe('当前消息');
  });
});

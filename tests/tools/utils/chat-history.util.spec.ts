import { extractLatestUserMessage } from '@tools/utils/chat-history.util';

describe('extractLatestUserMessage', () => {
  it('returns empty string for empty array', () => {
    expect(extractLatestUserMessage([])).toBe('');
  });

  it('returns empty string when all messages are assistant', () => {
    const messages = [
      { role: 'assistant', content: '你好' },
      { role: 'assistant', content: '还在吗' },
    ];
    expect(extractLatestUserMessage(messages)).toBe('');
  });

  it('returns the last user message when it is at the end', () => {
    const messages = [
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '回复' },
      { role: 'user', content: '最后一条' },
    ];
    expect(extractLatestUserMessage(messages)).toBe('最后一条');
  });

  it('returns the last user message when followed by assistant messages', () => {
    const messages = [
      { role: 'user', content: '用户消息' },
      { role: 'assistant', content: '回复1' },
      { role: 'assistant', content: '回复2' },
    ];
    expect(extractLatestUserMessage(messages)).toBe('用户消息');
  });

  it('returns the latest user message among multiple', () => {
    const messages = [
      { role: 'user', content: '早期' },
      { role: 'user', content: '中期' },
      { role: 'user', content: '最新' },
    ];
    expect(extractLatestUserMessage(messages)).toBe('最新');
  });
});

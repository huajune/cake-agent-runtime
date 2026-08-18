import {
  buildConversationCorpus,
  selectCorpusMessages,
  selectEvidenceDialogueMessages,
} from '@resolution/signal/corpus';

describe('conversation corpus（语料域分轨）', () => {
  // 语料域是出处判定的地基：teaching（revise 指令的 user transport）和 tool_result
  // 一旦漏进 evidence 域，模型自己写的示例值就会被当成候选人自陈入档。
  it('classifies user / assistant into the evidence domain', () => {
    const blocks = buildConversationCorpus([
      { role: 'user', content: '我叫王玥' },
      { role: 'assistant', content: '好的' },
    ]);

    expect(blocks).toEqual([
      { id: 'conversation-0', domain: 'evidence', role: 'user', content: '我叫王玥' },
      { id: 'conversation-1', domain: 'evidence', role: 'assistant', content: '好的' },
    ]);
  });

  it('routes tool messages to tool_result', () => {
    const [block] = buildConversationCorpus([{ role: 'tool', content: '{"jobs":[]}' }]);
    expect(block).toMatchObject({ domain: 'tool_result', role: 'tool' });
  });

  it('routes unknown roles to teaching（SDK 的 user transport 兜底不得抬成证据）', () => {
    const blocks = buildConversationCorpus([
      { role: 'system', content: '你是招聘助手' },
      { role: 'revise-instruction', content: '示例：姓名：测试娟' },
      { content: '没有 role 的消息' },
    ]);

    expect(blocks.map((block) => block.domain)).toEqual(['teaching', 'teaching', 'teaching']);
    expect(blocks.every((block) => block.role === 'system')).toBe(true);
  });

  it('skips non-object entries but keeps index-based ids stable for the rest', () => {
    const blocks = buildConversationCorpus([null, { role: 'user', content: '在吗' }, 'raw string']);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].id).toBe('conversation-1');
  });

  it('selectCorpusMessages filters by domain and role together', () => {
    const blocks = buildConversationCorpus([
      { role: 'user', content: '我叫王玥' },
      { role: 'assistant', content: '好的' },
      { role: 'tool', content: '{}' },
      { role: 'system', content: '示例' },
    ]);

    expect(selectCorpusMessages(blocks, { domains: ['evidence'], roles: ['user'] })).toEqual([
      { role: 'user', content: '我叫王玥' },
    ]);
    expect(selectCorpusMessages(blocks, { domains: ['tool_result'], roles: ['user'] })).toEqual([]);
  });

  it('selectEvidenceDialogueMessages 只放行 evidence 域的 user/assistant', () => {
    const blocks = buildConversationCorpus([
      { role: 'user', content: '我叫王玥' },
      { role: 'assistant', content: '好的' },
      { role: 'tool', content: '{"phone":"13800138000"}' },
      { role: 'system', content: '示例：手机号 13800138000' },
    ]);

    expect(selectEvidenceDialogueMessages(blocks)).toEqual([
      { role: 'user', content: '我叫王玥' },
      { role: 'assistant', content: '好的' },
    ]);
  });
});

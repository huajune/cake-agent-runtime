import { parseSummaryOutput } from '@memory/long-term/summary-format';

describe('parseSummaryOutput', () => {
  it('解析范围行并把 Markdown 标题/加粗归一为「标题：正文」单行', () => {
    const parsed = parseSummaryOutput(
      '范围：求职\n## 求职目标\n找兼职。\n\n**关键约束** 只做晚班\n进展与结果：推荐了肯德基。\n未决事项：待回复。',
    );

    expect(parsed.scope).toBe('job_seeking');
    expect(parsed.body).toBe(
      '求职目标：找兼职。\n关键约束：只做晚班\n进展与结果：推荐了肯德基。\n未决事项：待回复。',
    );
  });

  it('非求职范围被识别；范围行缺失时 scope 为 null 且正文原样保留', () => {
    expect(parseSummaryOutput('范围：非求职\n进展与结果：核对工时。').scope).toBe('other');

    const plain = parseSummaryOutput('求职目标：找兼职。\n关键约束：晚班');
    expect(plain.scope).toBeNull();
    expect(plain.body).toBe('求职目标：找兼职。\n关键约束：晚班');
  });

  it('范围行只在首行生效，正文中的「范围：」不被吞掉', () => {
    const parsed = parseSummaryOutput('求职目标：找兼职。\n范围：非求职');

    expect(parsed.scope).toBeNull();
    expect(parsed.body).toBe('求职目标：找兼职。\n范围：非求职');
  });

  it('空输入得到空正文', () => {
    expect(parseSummaryOutput('').body).toBe('');
    expect(parseSummaryOutput('范围：求职\n\n').body).toBe('');
  });
});

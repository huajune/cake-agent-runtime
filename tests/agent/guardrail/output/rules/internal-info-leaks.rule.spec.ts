import {
  detectOutputLeak,
  stripMarkdownCodeFences,
} from '@agent/guardrail/output/rules/internal-info-leaks.rule';

describe('stripMarkdownCodeFences', () => {
  it('removes fence markers while preserving the wrapped form template verbatim', () => {
    const draft = [
      '面试时间有周三、周四、周五的 10:30-15:00，你先填下资料。',
      '',
      '```text',
      '面试要求：先将以下资料补充下发给我，我来帮你约面试',
      '姓名：',
      '联系方式：',
      '```',
    ].join('\n');

    const stripped = stripMarkdownCodeFences(draft);

    expect(stripped).toContain('面试要求：先将以下资料补充下发给我，我来帮你约面试');
    expect(stripped).toContain('姓名：');
    expect(stripped).toContain('联系方式：');
    expect(stripped).not.toContain('```');
    // 剥离后不再命中泄漏词库——这是 runner 确定性快通道的放行前提
    expect(detectOutputLeak(stripped)).toBeNull();
  });

  it('keeps trailing content when the fence marker shares a line with text', () => {
    const stripped = stripMarkdownCodeFences('```text 面试要求：补充资料\n姓名：\n```');
    expect(stripped).toBe('面试要求：补充资料\n姓名：');
  });

  it('collapses the blank gap left by removed fence lines', () => {
    const stripped = stripMarkdownCodeFences('第一段\n\n```\n表单内容\n```\n\n第二段');
    expect(stripped).not.toMatch(/\n{3,}/);
    expect(stripped).toContain('表单内容');
  });

  it('returns text unchanged when there is no fence', () => {
    const plain = '正常回复，没有围栏。\n1. 选项一\n2. 选项二';
    expect(stripMarkdownCodeFences(plain)).toBe(plain);
  });

  it('does not clear other leak patterns: tool-name leak still detected after stripping', () => {
    const stripped = stripMarkdownCodeFences('```json\n{"name":"duliday_job_list"}\n```');
    expect(detectOutputLeak(stripped)).not.toBeNull();
  });
});

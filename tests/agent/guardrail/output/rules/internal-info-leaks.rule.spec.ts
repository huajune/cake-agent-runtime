import {
  detectOutputLeak,
  hasTechnicalDocumentationShape,
  isToolCallArtifactOnly,
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

/**
 * 2026-07-30 守卫审计 P0-2：用例取自 2026-07-28 15:05–15:11 模型降级窗口的生产首版
 * （模型停止发起工具调用，把调用语法当正文吐出），这些首版当时全部进了 rewrite，
 * 4/4 编出薪资/门店/伪造报名链接并投递。
 */
describe('isToolCallArtifactOnly', () => {
  it('识别 XML 骨架残文（trace …_1785222323383）', () => {
    const draft = [
      '<tool_call>',
      '<invoke name="duliday_job_list">',
      '<parameter name="cityNameList">["广州"]</parameter>',
      '<parameter name="regionNameList">["海珠区"]</parameter>',
      '<parameter name="includeJobSalary">true</parameter>',
      '</invoke>',
    ].join('\n');
    expect(isToolCallArtifactOnly(draft)).toBe(true);
  });

  it('识别 JSON 残文（trace …_1785222466898）', () => {
    expect(
      isToolCallArtifactOnly('{"name": "geocode", "parameters": {"address": "沈河区东陵路", "city": "沈阳"}}'),
    ).toBe(true);
  });

  it('识别调用式与裸工具名残文（trace …_1785222571474 / …_1785222602702）', () => {
    expect(isToolCallArtifactOnly('geocode(address="海珠", city="广州")')).toBe(true);
    expect(isToolCallArtifactOnly('duliday_job_list')).toBe(true);
    expect(isToolCallArtifactOnly('geocode')).toBe(true);
  });

  it('放行含候选人可见正文的回复——哪怕它同时泄漏了工具名', () => {
    expect(
      isToolCallArtifactOnly('我调用 duliday_job_list 帮你查了下，海珠这边有三家在招'),
    ).toBe(false);
  });

  it('放行正常回复与空文本', () => {
    expect(isToolCallArtifactOnly('好的，你在哪个区呀？我帮你看看附近的岗位')).toBe(false);
    expect(isToolCallArtifactOnly('')).toBe(false);
  });
});

/**
 * 2026-07-30 守卫审计 P0-3：确定性剥围栏快通道的领域合规前置。
 */
describe('hasTechnicalDocumentationShape', () => {
  it('识别跨域接口设计答案（trace …_1785222187376，剥围栏后原样投递给了候选人）', () => {
    const stripped = stripMarkdownCodeFences(
      [
        '明白。既然 TjybappHousingConfirm 表中的金额字段已经是“元 × 10000”的整型存储，那么接口返回时直接透传原值即可。',
        '',
        '```json',
        '{',
        '"confirm_id": "C202310250001",',
        '"amount": 150000',
        '}',
        '```',
        '',
        '### 核心映射规则',
        '| 原始表字段 | 返回JSON字段 | 处理方式 |',
        '| `amount` | `amount` | 整型原值透传 |',
      ].join('\n'),
    );

    expect(detectOutputLeak(stripped)).toBeNull(); // 剥完词库确实不再命中——正是旧快通道放行的原因
    expect(hasTechnicalDocumentationShape(stripped)).toBe(true);
  });

  it('放行报名表模板——2026-07-21 锚定判例的最小修复路径不受影响', () => {
    const stripped = stripMarkdownCodeFences(
      [
        '面试时间有周三、周四的 10:30-15:00，你先填下资料。',
        '```text',
        '姓名：',
        '联系方式：',
        '性别：',
        '年龄：',
        '应聘门店：上海宝山芈城科创中心店',
        '```',
      ].join('\n'),
    );

    expect(hasTechnicalDocumentationShape(stripped)).toBe(false);
  });

  it('放行只含单一弱信号的正常回复', () => {
    expect(hasTechnicalDocumentationShape('这个岗位要求填几个字段，你把姓名发我就行')).toBe(false);
    expect(hasTechnicalDocumentationShape('')).toBe(false);
  });
});

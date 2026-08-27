import {
  formatExtractionFactLines,
  formatTurnHintLines,
  RULE_CLAIM_QUOTE_RENDER_MAX_CHARS,
} from '@memory/fact-lines.formatter';
import {
  FALLBACK_EXTRACTION,
  sessionFactValue,
  toSessionFacts,
} from '@memory/short-term/short-term.types';
import { testTurnHint, testTurnHints } from '../helpers/turn-hints.fixture';

describe('formatExtractionFactLines', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should render known interview and preference fields in stable labels', () => {
    const lines = formatExtractionFactLines({
      ...FALLBACK_EXTRACTION,
      interview_info: {
        ...FALLBACK_EXTRACTION.interview_info,
        name: '张三',
        phone: '13800138000',
        age: '25',
        is_student: false,
      },
      preferences: {
        ...FALLBACK_EXTRACTION.preferences,
        city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
        district: ['杨浦区'],
      },
    });

    expect(lines).toEqual([
      '- 姓名: 张三',
      '- 联系方式: 13800138000',
      '- 年龄: 25',
      '- 是否学生: 否',
      '- 意向城市: 上海（置信度: high）',
      '- 意向区域: 杨浦区',
    ]);
  });

  it('should render brand from currentBrandName option only (§19.6)', () => {
    // 品牌唯一真相是 brand_state，由调用方经 options 显式注入；
    // facts 侧已无 brands 字段可读（记忆审计 S9 删除）。
    const lines = formatExtractionFactLines(FALLBACK_EXTRACTION, { currentBrandName: '来伊份' });

    expect(lines).toEqual(['- 意向品牌: 来伊份（来源: 会话品牌状态）']);
  });

  it('should render no brand line when currentBrandName is absent', () => {
    const lines = formatExtractionFactLines(FALLBACK_EXTRACTION);

    expect(lines).toEqual([]);
  });

  it('should skip empty fields', () => {
    expect(formatExtractionFactLines(FALLBACK_EXTRACTION)).toEqual([]);
  });

  it.each([
    {
      name: 'candidate self-report from the gender envelope',
      gender: sessionFactValue('女', {
        confidence: 'high',
        source: 'candidate_quote',
        evidence: '性别识别：女',
      }),
      genderSource: null,
      tag: '（候选人自陈）',
    },
    {
      name: 'untrusted system label from the gender envelope',
      gender: sessionFactValue('女', {
        confidence: 'medium',
        source: 'system',
        evidence: '企微客户详情',
      }),
      genderSource: null,
      tag: '（系统标签，未经候选人自陈，不得用于直接排除候选人）',
    },
    {
      name: 'booking-confirmed system value',
      gender: sessionFactValue('女', {
        confidence: 'high',
        source: 'system',
        evidence: '收资表单办结：性别',
      }),
      genderSource: null,
      tag: '（系统记录，报名办结已确认）',
    },
    {
      name: 'legacy candidate sibling fallback',
      gender: sessionFactValue('女', {
        confidence: 'high',
        source: 'rule',
        evidence: '旧规则轨',
      }),
      genderSource: sessionFactValue('candidate' as const, {
        confidence: 'high',
        source: 'rule',
        evidence: '旧 gender_source',
      }),
      tag: '（候选人自陈）',
    },
  ])('renders gender provenance: $name', ({ gender, genderSource, tag }) => {
    const base = toSessionFacts(FALLBACK_EXTRACTION, {
      confidence: 'medium',
      source: 'model',
      evidence: '测试基线',
    });
    const lines = formatExtractionFactLines({
      ...base,
      interview_info: {
        ...base.interview_info,
        gender,
        gender_source: genderSource,
      },
    });

    expect(lines).toEqual([expect.stringContaining(`- 性别: 女${tag}`)]);
  });

  it('should render Boss title brand ids', () => {
    const lines = formatExtractionFactLines({
      ...FALLBACK_EXTRACTION,
      preferences: {
        ...FALLBACK_EXTRACTION.preferences,
        brand_ids: [10239],
      },
    });

    expect(lines).toEqual(['- 意向品牌ID: 10239']);
  });

  it('should render high-confidence field metadata without evidence by default', () => {
    const facts = testTurnHints(testTurnHint('interview_info.age', '24', '年龄识别：24'));
    const lines = formatTurnHintLines(facts);

    expect(lines).toEqual(['- 年龄: 24（置信度: high，来源: rule）']);
  });

  it('should render evidence only when includeEvidence is set (extraction prompt path)', () => {
    const facts = testTurnHints(
      testTurnHint('interview_info.age', '24', '年龄识别：24', { quote: '我24' }),
    );
    const lines = formatTurnHintLines(facts, { includeEvidence: true });

    // 原话是主 Agent prompt 侧的 opt-in（includeQuote）；提取 prompt 与提取 LLM 共享原文，不重复注入
    expect(lines).toEqual(['- 年龄: 24（置信度: high，来源: rule，证据: 年龄识别：24）']);
  });

  // 议题 2-1：证据码只是结论的复述；候选人复述岗位要求时唯一的区分信号是逐字原话。
  describe('原话渲染（议题 2-1）', () => {
    it('renders the verbatim quote so a job-requirement echo is distinguishable', () => {
      const facts = testTurnHints(
        testTurnHint('interview_info.age', '18-45', '年龄识别：18-45', {
          quote: '这岗位要求18-45岁',
        }),
      );

      const [line] = formatTurnHintLines(facts, {
        includeEvidence: true,
        includeQuote: true,
        currentTurnTexts: ['这岗位要求18-45岁吗', '我想问下'],
      });

      expect(line).toContain('证据: 年龄识别：18-45');
      expect(line).toContain('原话: 这岗位要求18-45岁');
    });

    it('omits the quote on a single-message turn when it is the whole message', () => {
      const message = '我今年24，在上海想找兼职';
      const facts = testTurnHints(
        testTurnHint('interview_info.age', '24', '年龄识别：24', { quote: message }),
      );

      const [line] = formatTurnHintLines(facts, {
        includeEvidence: true,
        includeQuote: true,
        currentTurnTexts: [message],
      });

      expect(line).toContain('证据: 年龄识别：24');
      expect(line).not.toContain('原话:');
    });

    it('keeps whole-message quotes on merged turns so each claim maps to its source message', () => {
      const first = '我今年24';
      const second = '我在上海';
      const lines = formatTurnHintLines(
        testTurnHints(
          testTurnHint('interview_info.age', '24', '年龄识别：24', { quote: first }),
          testTurnHint('preferences.city', '上海', 'explicit_city', { quote: second }),
        ),
        { includeEvidence: true, includeQuote: true, currentTurnTexts: [first, second] },
      );

      expect(lines.find((line) => line.includes('年龄'))).toContain(`原话: ${first}`);
      expect(lines.find((line) => line.includes('意向城市'))).toContain(`原话: ${second}`);
    });

    it('truncates long quotes instead of re-injecting the whole message per field', () => {
      const long = '我'.repeat(200);
      const [line] = formatTurnHintLines(
        testTurnHints(testTurnHint('interview_info.age', '24', '年龄识别：24', { quote: long })),
        { includeEvidence: true, includeQuote: true, currentTurnTexts: ['另一条消息', '再一条'] },
      );

      expect(line).toContain(`原话: ${'我'.repeat(RULE_CLAIM_QUOTE_RENDER_MAX_CHARS)}…`);
      expect(line.length).toBeLessThan(120);
    });
  });
});

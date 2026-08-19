import {
  formatExtractionFactLines,
  formatRuleFactClaimLines,
  RULE_CLAIM_QUOTE_RENDER_MAX_CHARS,
} from '@memory/formatters/fact-lines.formatter';
import { FALLBACK_EXTRACTION } from '@memory/types/session-facts.types';
import { testRuleFact, testRuleFacts } from '../../helpers/rule-fact-claims.fixture';

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

  it('should render brand from currentBrandName option, never from retired preferences.brands (§19.6)', () => {
    // 品牌唯一真相是 brand_state，由调用方经 options 显式注入；
    // facts 里即使残留旧存储值（收口前写入）也不得渲染。
    const lines = formatExtractionFactLines(
      {
        ...FALLBACK_EXTRACTION,
        preferences: {
          ...FALLBACK_EXTRACTION.preferences,
          brands: ['旧存储残留品牌'],
        },
      },
      { currentBrandName: '来伊份' },
    );

    expect(lines).toEqual(['- 意向品牌: 来伊份（来源: 会话品牌状态）']);
  });

  it('should render no brand line when currentBrandName is absent', () => {
    const lines = formatExtractionFactLines({
      ...FALLBACK_EXTRACTION,
      preferences: {
        ...FALLBACK_EXTRACTION.preferences,
        brands: ['旧存储残留品牌'],
      },
    });

    expect(lines).toEqual([]);
  });

  it('should skip empty fields', () => {
    expect(formatExtractionFactLines(FALLBACK_EXTRACTION)).toEqual([]);
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
    const facts = testRuleFacts(testRuleFact('interview_info.age', '24', '年龄识别：24'));
    const lines = formatRuleFactClaimLines(facts);

    expect(lines).toEqual(['- 年龄: 24（置信度: high，来源: rule）']);
  });

  it('should render evidence only when includeEvidence is set (extraction prompt path)', () => {
    const facts = testRuleFacts(
      testRuleFact('interview_info.age', '24', '年龄识别：24', { quote: '我24' }),
    );
    const lines = formatRuleFactClaimLines(facts, { includeEvidence: true });

    // 原话是主 Agent prompt 侧的 opt-in（includeQuote）；提取 prompt 与提取 LLM 共享原文，不重复注入
    expect(lines).toEqual(['- 年龄: 24（置信度: high，来源: rule，证据: 年龄识别：24）']);
  });

  // 议题 2-1：证据码只是结论的复述；候选人复述岗位要求时唯一的区分信号是逐字原话。
  describe('原话渲染（议题 2-1）', () => {
    it('renders the verbatim quote so a job-requirement echo is distinguishable', () => {
      const facts = testRuleFacts(
        testRuleFact('interview_info.age', '18-45', '年龄识别：18-45', {
          quote: '这岗位要求18-45岁',
        }),
      );

      const [line] = formatRuleFactClaimLines(facts, {
        includeEvidence: true,
        includeQuote: true,
        currentTurnTexts: ['这岗位要求18-45岁吗', '我想问下'],
      });

      expect(line).toContain('证据: 年龄识别：18-45');
      expect(line).toContain('原话: 这岗位要求18-45岁');
    });

    it('omits the quote on a single-message turn when it is the whole message', () => {
      const message = '我今年24，在上海想找兼职';
      const facts = testRuleFacts(
        testRuleFact('interview_info.age', '24', '年龄识别：24', { quote: message }),
      );

      const [line] = formatRuleFactClaimLines(facts, {
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
      const lines = formatRuleFactClaimLines(
        testRuleFacts(
          testRuleFact('interview_info.age', '24', '年龄识别：24', { quote: first }),
          testRuleFact('preferences.city', '上海', 'explicit_city', { quote: second }),
        ),
        { includeEvidence: true, includeQuote: true, currentTurnTexts: [first, second] },
      );

      expect(lines.find((line) => line.includes('年龄'))).toContain(`原话: ${first}`);
      expect(lines.find((line) => line.includes('意向城市'))).toContain(`原话: ${second}`);
    });

    it('truncates long quotes instead of re-injecting the whole message per field', () => {
      const long = '我'.repeat(200);
      const [line] = formatRuleFactClaimLines(
        testRuleFacts(testRuleFact('interview_info.age', '24', '年龄识别：24', { quote: long })),
        { includeEvidence: true, includeQuote: true, currentTurnTexts: ['另一条消息', '再一条'] },
      );

      expect(line).toContain(`原话: ${'我'.repeat(RULE_CLAIM_QUOTE_RENDER_MAX_CHARS)}…`);
      expect(line.length).toBeLessThan(120);
    });
  });

  it('should warn when a time-sensitive fact is stale (extractedAt > 24h ago)', () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-13T10:00:00+08:00'));
    const staleAt = '2026-07-06T14:35:00+08:00';
    const lines = formatExtractionFactLines({
      ...FALLBACK_EXTRACTION,
      interview_info: {
        ...FALLBACK_EXTRACTION.interview_info,
        interview_time: {
          value: '明天下午2点',
          confidence: 'medium',
          source: 'model',
          evidence: 'LLM 结构化提取',
          extractedAt: staleAt,
        },
      },
    } as unknown as Parameters<typeof formatExtractionFactLines>[0]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('- 面试时间: 明天下午2点');
    expect(lines[0]).toContain(
      '⚠️记录时间：2026-07-06 14:35；其中的相对时间表述以该记录时间为基准，可能已失效',
    );
  });

  it('should render a complete Beijing timestamp for a fresh time-sensitive fact', () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-13T15:00:00+08:00'));
    const lines = formatExtractionFactLines({
      ...FALLBACK_EXTRACTION,
      interview_info: {
        ...FALLBACK_EXTRACTION.interview_info,
        applied_store: {
          value: '顺德欢乐海岸PH',
          confidence: 'high',
          source: 'model',
          evidence: '候选人确认应聘门店',
          extractedAt: '2026-07-13T14:35:00+08:00',
        },
      },
    } as unknown as Parameters<typeof formatExtractionFactLines>[0]);

    expect(lines).toContain(
      '- 应聘门店: 顺德欢乐海岸PH（置信度: high，来源: model）（记录时间：2026-07-13 14:35）',
    );
  });
});

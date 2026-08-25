import { PromptContext } from '@agent/generator/context/sections/section.interface';
import { TurnHintsSection } from '@agent/generator/context/sections/working/turn-hints.section';
import { testTurnHint, testTurnHints } from '../../../../helpers/turn-hints.fixture';
import { cityFixture, sessionFactsOf } from '../../../../helpers/session-facts.fixture';

describe('TurnHintsSection', () => {
  const section = new TurnHintsSection();
  const baseCtx: PromptContext = {
    scenario: 'candidate-consultation',
    channelType: 'private',
    strategyConfig: {} as PromptContext['strategyConfig'],
  };

  it('should return empty string when no high-confidence facts', () => {
    expect(section.build(baseCtx)).toBe('');
  });

  it('should render high-confidence facts as a single runtime hints block when no session facts exist', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: null,
      // brands 已随 preferences.brands 退役不再进 turn hints（§19.6），用 district 验证同一数组渲染路径
      turnHints: testTurnHints(
        testTurnHint('preferences.district', ['杨浦区'], '区域识别：杨浦区'),
      ),
    });

    expect(output).toContain('[本轮解析线索]');
    expect(output).toContain('意向区域: 杨浦区');
    expect(output).toContain('严禁向候选人复述或提及“系统识别/系统提示/系统解析”字样');
    expect(output).not.toContain('[本轮待确认线索]');
  });

  it('should render city confidence and evidence inline in high-confidence hints block', () => {
    const message = '我在杨浦';
    const output = section.build({
      ...baseCtx,
      sessionFacts: null,
      currentTurnTexts: [message],
      turnHints: testTurnHints(
        testTurnHint('preferences.city', '上海', 'unique_district_alias', { quote: message }),
      ),
    });

    expect(output).toContain('[本轮解析线索]');
    expect(output).toContain(
      '意向城市: 上海（置信度: high，来源: rule，证据: unique_district_alias）',
    );
  });

  // 议题 2-2：城市行的「证据」是全库唯一渲染机器码的字段，文案必须是词典而非分档教学
  // （规则轨 city 的 confidence 恒为 high，不存在需要区别对待的档位）。
  it('explains the city evidence codes as a dictionary instead of a confidence tier lesson', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: null,
      turnHints: testTurnHints(testTurnHint('preferences.city', '上海', 'unique_district_alias')),
    });

    expect(output).toContain('municipality_compact=直辖市紧凑写法');
    expect(output).toContain('explicit_city=显式城市名');
    expect(output).toContain('unique_district_alias=全国唯一区名映射');
    expect(output).toContain('hotspot_alias=热门地标映射');
    expect(output).not.toContain('confidence=high 的结果来自明确规则匹配');
  });

  // 议题 2-3：geocode 口径收敛到 hard-constraints 单一段落，本段只留指针。
  it('defers the geocode policy to the hard-constraint section instead of restating it', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: null,
      turnHints: testTurnHints(
        testTurnHint('preferences.district', ['杨浦区'], '区域识别：杨浦区'),
      ),
    });

    expect(output).toContain('口径见 [本轮查询硬约束]');
    expect(output).not.toContain('行政区域可直接查岗');
  });

  // 议题 2-1：合并轮里每条 claim 必须能对回自己的来源消息。
  it('maps each claim back to its source message on a merged turn', () => {
    const first = '我今年24';
    const second = '我在上海想找兼职';
    const output = section.build({
      ...baseCtx,
      sessionFacts: null,
      currentTurnTexts: [first, second],
      turnHints: testTurnHints(
        testTurnHint('interview_info.age', '24', '年龄识别：24', { quote: first }),
        testTurnHint('preferences.city', '上海', 'explicit_city', { quote: second }),
      ),
    });

    expect(output).toContain(`原话: ${first}`);
    expect(output).toContain(`原话: ${second}`);
  });

  it('does not re-inject the whole message per field on a single-message turn', () => {
    const message = '我今年24，在上海想找兼职';
    const output = section.build({
      ...baseCtx,
      sessionFacts: null,
      currentTurnTexts: [message],
      turnHints: testTurnHints(
        testTurnHint('interview_info.age', '24', '年龄识别：24', { quote: message }),
        testTurnHint('preferences.city', '上海', 'explicit_city', { quote: message }),
      ),
    });

    expect(output).not.toContain('原话:');
  });

  it('should render low-confidence facts to LLM with labels instead of filtering them out', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: null,
      turnHints: testTurnHints(
        testTurnHint('interview_info.gender', '女', '客户详情接口补充性别：女', {
          confidence: 'low',
          producer: 'system',
        }),
      ),
    });

    expect(output).toContain('[本轮解析线索]');
    expect(output).toContain(
      '性别: 女（系统标签，未经候选人自陈，不得用于直接排除候选人）（置信度: low，来源: system，证据: 客户详情接口补充性别：女，原话: 客户详情接口补充性别：女）',
    );
  });

  it('projects candidate_quote gender as candidate self-report without a sibling claim', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: null,
      turnHints: testTurnHints(
        testTurnHint('interview_info.gender', '男', '性别识别：男', {
          producer: 'candidate_quote',
        }),
      ),
    });

    expect(output).toContain(
      '性别: 男（候选人自陈）（置信度: high，来源: candidate_quote，证据: 性别识别：男',
    );
  });

  it('should move conflicting fields into pending confirmation hints and keep new fields in normal hints', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({ preferences: { city: cityFixture('上海') } }),
      turnHints: testTurnHints(
        testTurnHint('preferences.district', ['杨浦区'], '区域识别：杨浦区'),
        testTurnHint('preferences.city', '北京', 'explicit_city'),
      ),
    });

    expect(output).toContain('[本轮解析线索]');
    expect(output).toContain('[本轮待确认线索]');
    expect(output).toContain('意向区域: 杨浦区');
    expect(output).toContain('意向城市: 北京');

    const highConfidenceIndex = output.indexOf('[本轮解析线索]');
    const pendingIndex = output.indexOf('[本轮待确认线索]');
    const cityIndex = output.indexOf('意向城市: 北京');
    expect(pendingIndex).toBeGreaterThan(highConfidenceIndex);
    expect(cityIndex).toBeGreaterThan(pendingIndex);
  });

  it('should still render current-turn facts when they match session facts', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({ preferences: { city: cityFixture('上海') } }),
      currentTurnTexts: ['我在上海'],
      turnHints: testTurnHints(
        testTurnHint('preferences.city', '上海', 'explicit_city', { quote: '我在上海' }),
      ),
    });

    expect(output).toContain('[本轮解析线索]');
    expect(output).toContain('意向城市: 上海（置信度: high，来源: rule，证据: explicit_city）');
    expect(output).not.toContain('[本轮待确认线索]');
  });

  it('treats a current labor-form change as the active intent instead of pending confirmation', () => {
    const output = section.build({
      ...baseCtx,
      sessionFacts: sessionFactsOf({ preferences: { labor_form: '兼职' } }),
      turnHints: testTurnHints(
        testTurnHint('preferences.labor_form', '暑假工', '用工形式识别：暑假工'),
      ),
    });

    expect(output).toContain('[本轮解析线索]');
    expect(output).toContain('用工形式: 暑假工');
    expect(output).not.toContain('[本轮待确认线索]');
  });
});

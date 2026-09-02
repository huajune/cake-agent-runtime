import { createHash } from 'node:crypto';
import {
  CriticalTurnGuardSection,
  FINAL_CHECK_RULES,
  FinalCheckSection,
} from '@agent/generator/context/sections/procedural/final-check.section';
import { buildPromptSectionBlocks } from '@agent/generator/context/sections/section.interface';

/** 锁定 turn 规则的匹配语义：patterns 全部命中 target 文本。 */
const matches = (ruleId: string, text: string): boolean => {
  const rule = FINAL_CHECK_RULES.find((item) => item.id === ruleId);
  if (!rule || rule.trigger !== 'turn') throw new Error(`turn rule not found: ${ruleId}`);
  return rule.patterns.every((pattern) => pattern.test(text));
};

describe('FinalCheckSection', () => {
  it('renders the always checklist as the first block with adjudicated group order', () => {
    const blocks = buildPromptSectionBlocks(new FinalCheckSection(), {} as never);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual(
      expect.objectContaining({ id: 'final-check', domain: 'teaching', role: 'system' }),
    );
    const content = blocks[0].content;
    expect(content.startsWith('# 发送前自检（全部需通过）')).toBe(true);
    expect(content.indexOf('## 普适元规则')).toBeGreaterThan(0);
    expect(content.indexOf('## 普适元规则')).toBeLessThan(
      content.indexOf('## 承诺-工具一致性（说出口的事必须真发生）'),
    );
    expect(content.indexOf('## 承诺-工具一致性（说出口的事必须真发生）')).toBeLessThan(
      content.indexOf('## 表达自检'),
    );
    const alwaysCount = FINAL_CHECK_RULES.filter((rule) => rule.trigger === 'always').length;
    expect(content.match(/^- /gmu)).toHaveLength(alwaysCount);
    expect(Buffer.byteLength(content)).toBe(5930);
    expect(createHash('sha256').update(content).digest('hex')).toBe(
      '891892434a8ea0be1cbbca057148530e36f5d14470dd5df5352e4c6ae273a811',
    );
  });

  it('keeps the legacy injected bytes unchanged for a matched current-turn rule', () => {
    const rule = FINAL_CHECK_RULES.find((item) => item.id === 'interview_date_precheck_first');
    const blocks = buildPromptSectionBlocks(new CriticalTurnGuardSection(), {
      currentUserMessage: '我5月1号回来面试可以吗',
      normalizedMessages: [{ role: 'user', content: '我5月1号回来面试可以吗' }],
    } as never);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual(
      expect.objectContaining({ id: 'critical-turn-guard', domain: 'teaching', role: 'system' }),
    );
    expect(blocks[0].content).toBe(`# 本轮动态硬禁令\n- ${rule?.text}`);
    expect(createHash('sha256').update(blocks[0].content).digest('hex')).toBe(
      'bd598c8e0d9b387a08e87c5674a8830cba616e189dc3ec9a756c4594abfcf5e6',
    );
  });

  it('emits no critical-turn-guard block when nothing matches', () => {
    const blocks = buildPromptSectionBlocks(new CriticalTurnGuardSection(), {
      currentUserMessage: '你好',
      normalizedMessages: [{ role: 'user', content: '你好' }],
    } as never);

    expect(blocks).toEqual([]);
  });

  describe('interview_time_only_precheck_first（CUTOFF 缺口：裸钟点动身不重新 precheck）', () => {
    it.each([
      '我三点过去',
      '那我3点过来',
      '下午两点半到店',
      '我2点出发',
      '三点吧',
      '3点可以',
      '十点来得及吗',
    ])('fires on bare-clock departure/confirmation: %s', (text) => {
      expect(matches('interview_time_only_precheck_first', text)).toBe(true);
    });

    it.each([
      '三点到五点都可以', // 时段区间，不是动身
      '3点到5点有空',
      '我五点下班',
      '你们几点关门',
      '今天可以吗', // 日期征询归 interview_date_precheck_first
      '好的谢谢',
    ])('does NOT fire on ranges / off-topic clock mentions: %s', (text) => {
      expect(matches('interview_time_only_precheck_first', text)).toBe(false);
    });

    it('guard text demands same-turn precheck and forbids reusing stale "今天可以"', () => {
      const rule = FINAL_CHECK_RULES.find(
        (item) => item.id === 'interview_time_only_precheck_first',
      );
      if (rule?.trigger !== 'turn') throw new Error('expected turn rule');
      expect(rule.target).toBe('current');
      expect(rule.text).toContain('duliday_interview_precheck');
      expect(rule.text).toContain('严禁沿用');
      expect(rule.text).toContain('date_unavailable');
    });
  });

  describe('interview_date_precheck_first（既有行为回归）', () => {
    it.each(['今天面试可以吗', '明天下午三点可以吗', '周四面试方便吗'])(
      'still fires on date-bearing interview asks: %s',
      (text) => {
        expect(matches('interview_date_precheck_first', text)).toBe(true);
      },
    );
  });
});

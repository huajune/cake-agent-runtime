import {
  CRITICAL_TURN_GUARD_RULES,
  CriticalTurnGuardSection,
} from '@agent/generator/context/sections/procedural/critical-turn-guard.section';

/** 锁定 section 规则表的匹配语义：patterns 全部命中 target 文本。 */
const matches = (ruleId: string, text: string): boolean => {
  const rule = CRITICAL_TURN_GUARD_RULES.find((item) => item.id === ruleId);
  if (!rule) throw new Error(`rule not found: ${ruleId}`);
  return rule.patterns.every((pattern) => pattern.test(text));
};

describe('CriticalTurnGuardSection', () => {
  it('keeps the legacy injected bytes unchanged for a matched current-turn rule', () => {
    const rule = CRITICAL_TURN_GUARD_RULES.find(
      (item) => item.id === 'interview_date_precheck_first',
    );
    const output = new CriticalTurnGuardSection().build({
      currentUserMessage: '我5月1号回来面试可以吗',
      normalizedMessages: [{ role: 'user', content: '我5月1号回来面试可以吗' }],
    } as never);

    expect(output).toBe(`\n\n# 本轮动态硬禁令\n- ${rule?.guard}`);
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
      const rule = CRITICAL_TURN_GUARD_RULES.find(
        (item) => item.id === 'interview_time_only_precheck_first',
      );
      expect(rule?.target).toBe('current');
      expect(rule?.guard).toContain('duliday_interview_precheck');
      expect(rule?.guard).toContain('严禁沿用');
      expect(rule?.guard).toContain('date_unavailable');
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

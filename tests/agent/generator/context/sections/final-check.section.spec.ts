import { createHash } from 'node:crypto';
import {
  CriticalTurnGuardSection,
  FINAL_CHECK_RULES,
  FinalCheckSection,
} from '@agent/generator/context/sections/procedural/final-check.section';
import { resolveCriticalTurnInstructions } from '@agent/generator/preparation/turn-context-resolver';
import { promptModelOf } from '../../../../helpers/prompt-model.fixture';

/** 锁定 turn 规则的匹配语义：patterns 全部命中 target 文本。 */
const matches = (ruleId: string, text: string): boolean => {
  const rule = FINAL_CHECK_RULES.find((item) => item.id === ruleId);
  if (!rule || rule.trigger !== 'turn') throw new Error(`turn rule not found: ${ruleId}`);
  return rule.patterns.every((pattern) => pattern.test(text));
};

describe('tattoo_self_report_soft_decline (default tattoo gate)', () => {
  it.each(['我有纹身', '胳膊上纹了个纹身能做吗', '有文身要不要', '身上有刺青，介意吗'])(
    'triggers on candidate self-report: %s',
    (text) => expect(matches('tattoo_self_report_soft_decline', text)).toBe(true),
  );

  it.each([
    '你们这要求不能有纹身吗',
    '纹身店在附近',
    '我朋友有纹身',
    '我没有纹身',
    '我身上没有纹身',
    '我不接受有纹身的岗位',
  ])('does not trigger on generic mention without self-report: %s', (text) =>
    expect(matches('tattoo_self_report_soft_decline', text)).toBe(false),
  );

  it('injects the shared restricted rejection wording', () => {
    const rule = FINAL_CHECK_RULES.find((item) => item.id === 'tattoo_self_report_soft_decline');
    expect(rule?.text).toContain('这家的岗位跟你这边暂时没太对上');
    expect(rule?.text).toContain('不得追问纹身位置');
  });
});

describe('bare_number_reply_is_age_first / gender_self_report_check', () => {
  it.each(['17', '19 的不要？', '45可以吗', '我38'])(
    'bare two-digit reply triggers age-first: %s',
    (text) => expect(matches('bare_number_reply_is_age_first', text)).toBe(true),
  );
  it.each(['17点可以吗', '我要19元', '明天下午三点', '17:30'])(
    'does not trigger on non-bare numbers: %s',
    (text) => expect(matches('bare_number_reply_is_age_first', text)).toBe(false),
  );

  it.each([
    '我是男生',
    '本人女',
    '我女的',
    '我是男的可以吗',
    '你好我是男的',
    '请问我是男生可以做吗',
  ])('gender self-report triggers: %s', (text) =>
    expect(matches('gender_self_report_check', text)).toBe(true),
  );
  it.each(['我是男朋友推荐来的', '我女儿想找工作', '男女不限吗'])(
    'does not trigger on relatives/questions: %s',
    (text) => expect(matches('gender_self_report_check', text)).toBe(false),
  );
});

describe('FinalCheckSection', () => {
  it('renders the always checklist as the first block with adjudicated group order', () => {
    const blocks = new FinalCheckSection().build();

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
    const currentUserMessage = '我5月1号回来面试可以吗';
    const blocks = new CriticalTurnGuardSection().build(
      promptModelOf({
        criticalTurnInstructions: resolveCriticalTurnInstructions({
          currentUserMessage,
          normalizedMessages: [{ role: 'user', content: currentUserMessage }],
        }),
      }),
    );

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
    const blocks = new CriticalTurnGuardSection().build(
      promptModelOf({
        criticalTurnInstructions: resolveCriticalTurnInstructions({
          currentUserMessage: '你好',
          normalizedMessages: [{ role: 'user', content: '你好' }],
        }),
      }),
    );

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

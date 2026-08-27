import { DISCRIMINATION_LEAK_RULES } from '@agent/guardrail/output/rules/discrimination-leaks.rule';

function ruleById(ruleId: string) {
  const rule = DISCRIMINATION_LEAK_RULES.find((item) => item.ruleId === ruleId);
  if (!rule) throw new Error(`rule ${ruleId} not registered`);
  return rule;
}

describe('discriminatory_screening_leak', () => {
  const rule = ruleById('discriminatory_screening_leak');

  it.each(['这家不招外地户籍', '这个岗位只招食品专业', '少数民族有限制', '方便问下你结婚了吗'])(
    '拦截封闭的敏感属性限招/拒收形态：%s',
    (reply) => {
      expect(rule.keywords.test(reply)).toBe(true);
    },
  );

  it.each([
    '户籍没有要求，哪里人都能报',
    '专业不限，学历初中以上就行',
    '这个岗位的专业内容主要是食品加工',
  ])('不把合规安抚或普通专业描述扩成语义判断：%s', (reply) => {
    expect(rule.keywords.test(reply)).toBe(false);
  });
});

describe('sensitive_origin_probe', () => {
  const rule = ruleById('sensitive_origin_probe');

  it.each(['方便问下你老家是哪里？', '你是哪边人呀？', '你是本地人吗？'])(
    '拦截封闭的籍贯探问：%s',
    (reply) => expect(rule.keywords.test(reply)).toBe(true),
  );

  it.each([
    '方便问一下你常驻在哪个城市吗？',
    '你想去哪个城市工作呀？',
    '你先忙家里的事，回老家路上注意安全',
    '麻烦填下报名资料：\n籍贯/户籍：',
  ])('放行常驻/意向城市、关怀和确定性表单字段：%s', (reply) => {
    expect(rule.keywords.test(reply)).toBe(false);
  });
});

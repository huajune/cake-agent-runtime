import {
  candidateValuesEquivalent,
  deriveFieldValueFromQuote,
  normalizedIncludes,
  parseBirthYearAge,
  parseSpokenHeightCm,
  parseSpokenWeightKg,
} from '@resolution/evidence/normalize';

// 证据化方案 §12 条目 4：口语化表达的白名单归一化。
describe('candidate-fact-normalizers 口语归一化（§12-4）', () => {
  it('"一米六三" → 163cm', () => {
    expect(parseSpokenHeightCm('我一米六三')).toBe(163);
  });

  it('"一米七" → 170cm（单位数补零）', () => {
    expect(parseSpokenHeightCm('身高一米七')).toBe(170);
  });

  it('"九十二斤" → 46kg（斤减半）', () => {
    expect(parseSpokenWeightKg('体重九十二斤')).toBe(46);
  });

  it('"60公斤" 直读', () => {
    expect(parseSpokenWeightKg('60公斤')).toBe(60);
  });

  it('"我03年的" → 按当前年份推算年龄，而不是 3 岁（方案 §1）', () => {
    expect(parseBirthYearAge('我03年的', new Date('2026-08-05'))).toBe(23);
  });

  it('deriveFieldValueFromQuote 走完整字段路由：height 键值对与口语并存', () => {
    expect(deriveFieldValueFromQuote('height', '身高：170')).toBe(170);
    expect(deriveFieldValueFromQuote('height', '我一米六三')).toBe(163);
    expect(deriveFieldValueFromQuote('height', '想找晚班工作')).toBeNull();
  });
});

describe('normalizedIncludes 证据包含匹配', () => {
  it('折叠全半角、空白和中英文标点差异', () => {
    expect(normalizedIncludes('学历： 本 科。ＡＢＣ', '学历:本科ABC')).toBe(true);
  });

  it('不做改写或语义相似匹配', () => {
    expect(normalizedIncludes('我的学历是大学本科', '我本科毕业了')).toBe(false);
  });

  it('空 needle 不得命中', () => {
    expect(normalizedIncludes('任意原文', ' ，。 ')).toBe(false);
  });
});

describe('candidateValuesEquivalent 跨形态等价（booking 对账口径）', () => {
  it.each([
    ['height', '163cm', 163],
    ['weight', '46kg', 46],
    ['householdProvince', '安徽省', '安徽'],
    ['gender', 2, '女'],
    ['healthCertificate', 1, '有'],
    ['age', '24岁', 24],
    ['education', '中专', '技校'],
  ] as const)('%s: %p ≡ %p', (field, a, b) => {
    expect(candidateValuesEquivalent(field, a, b)).toBe(true);
  });

  it('不同值不等价，空值恒不等价', () => {
    expect(candidateValuesEquivalent('age', 24, 25)).toBe(false);
    expect(candidateValuesEquivalent('name', '', '')).toBe(false);
  });
});

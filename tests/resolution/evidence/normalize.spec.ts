import {
  candidateValuesEquivalent,
  deriveFieldValueFromQuote,
  experienceValueSupportedByQuote,
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

  describe('裸年份（生产 chat 6a8d583b：候选人报「93年」，年龄整轮取不到）', () => {
    const now = new Date('2026-08-28');

    it('无后缀的两位/四位年份都能取到', () => {
      expect(parseBirthYearAge('93年', now)).toBe(33);
      expect(parseBirthYearAge('1993年', now)).toBe(33);
      expect(parseBirthYearAge('93年，虚岁应该是33', now)).toBe(33);
      expect(parseBirthYearAge('陈佚非  93年  15001908960 男 有健康证', now)).toBe(33);
    });

    it('时长语境一律不认——裸年份与工龄同形，收窄用词表才安全', () => {
      expect(parseBirthYearAge('做了10年', now)).toBeNull();
      expect(parseBirthYearAge('工作了12年', now)).toBeNull();
      expect(parseBirthYearAge('12年经验', now)).toBeNull();
      expect(parseBirthYearAge('干了10年以上', now)).toBeNull();
    });

    it('带 的/生/出生 后缀时不受时长词表影响（表述已自证是出生年）', () => {
      expect(parseBirthYearAge('做过的工作不少，我93年的', now)).toBe(33);
      expect(parseBirthYearAge('1993年生', now)).toBe(33);
    });

    it('手机号数字串与越出 14-70 岁的推算结果都不产出年龄', () => {
      expect(parseBirthYearAge('15001908960', now)).toBeNull();
      expect(parseBirthYearAge('干了23年', now)).toBeNull();
    });
  });

  it('deriveFieldValueFromQuote 走完整字段路由：height 键值对与口语并存', () => {
    expect(deriveFieldValueFromQuote('height', '身高：170')).toBe(170);
    expect(deriveFieldValueFromQuote('height', '我一米六三')).toBe(163);
    expect(deriveFieldValueFromQuote('height', '想找晚班工作')).toBeNull();
  });
});

describe('normalizedIncludes 证据包含匹配', () => {
  it('折叠全半角与空白差异', () => {
    expect(normalizedIncludes('学历： 本 科ＡＢＣ', '学历:本科ABC')).toBe(true);
  });

  it('不折叠标点：否定分界不可被伪造 quote 抹掉（PR #1000 评审 P0-5）', () => {
    // 候选人原话「不，是学生」——若折叠标点，伪造 quote「不是学生」会命中原文，
    // 值反转被干净接受。
    expect(normalizedIncludes('不，是学生', '不是学生')).toBe(false);
    expect(normalizedIncludes('不，是学生', '不，是学生')).toBe(true);
  });

  it('不做改写或语义相似匹配', () => {
    expect(normalizedIncludes('我的学历是大学本科', '我本科毕业了')).toBe(false);
  });

  it('空 needle 不得命中', () => {
    expect(normalizedIncludes('任意原文', '   ')).toBe(false);
  });
});

describe('experienceValueSupportedByQuote 合成经历出处（PR #1000 评审 P0-3）', () => {
  it('「公司+岗位+时长」合成短句可被原话二元组覆盖支持', () => {
    expect(experienceValueSupportedByQuote('我之前在肯德基后厨干过一年', '肯德基后厨1年')).toBe(
      true,
    );
    expect(experienceValueSupportedByQuote('在麦当劳做服务员做了两年多', '麦当劳服务员2年')).toBe(
      true,
    );
  });

  it('与原话无关的臆造经历不被支持', () => {
    expect(experienceValueSupportedByQuote('我之前在肯德基后厨干过一年', '星巴克咖啡师3年')).toBe(
      false,
    );
    expect(experienceValueSupportedByQuote('想找个兼职', '海底捞服务员2年')).toBe(false);
  });

  it('短值退回逐字包含', () => {
    expect(experienceValueSupportedByQuote('做过饭店', '饭店')).toBe(true);
    expect(experienceValueSupportedByQuote('没做过', '饭店')).toBe(false);
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

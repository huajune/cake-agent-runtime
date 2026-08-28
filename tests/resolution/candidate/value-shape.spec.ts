import { candidateValuesEquivalent } from '@resolution/candidate/value-equivalence';
import {
  deriveFieldValueFromQuote,
  parseBirthYearAge,
  parseSpokenHeightCm,
  parseSpokenWeightKg,
} from '@resolution/candidate/value-shape';

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

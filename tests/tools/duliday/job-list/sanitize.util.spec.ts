import {
  cleanInternalStoreCode,
  normalizeStoreNameForAgent,
} from '@tools/duliday/job-list/sanitize.util';

describe('cleanInternalStoreCode', () => {
  describe('strips sponge-style internal numeric codes', () => {
    it('strips "品牌-数字-门店" 中段 (badcase 2xcajl7w 同类)', () => {
      expect(cleanInternalStoreCode('奥乐齐-1084-奉贤苏宁广场')).toBe('奥乐齐奉贤苏宁广场');
    });

    it('strips "品牌-数字门店" 紧贴中文 (badcase 2xcajl7w 原文)', () => {
      expect(cleanInternalStoreCode('奥乐齐-1084奉贤苏宁广场')).toBe('奥乐齐奉贤苏宁广场');
    });

    it('strips trailing "-数字" code', () => {
      expect(cleanInternalStoreCode('奥乐齐 1084')).toBe('奥乐齐');
      expect(cleanInternalStoreCode('成都你六姐-1234')).toBe('成都你六姐');
    });

    it('strips multiple internal codes in one name', () => {
      expect(cleanInternalStoreCode('品牌-1234-门店-5678')).toBe('品牌门店');
    });
  });

  describe('preserves legitimate digits', () => {
    it('keeps short digits embedded in store names (not 3+ digit code patterns)', () => {
      expect(cleanInternalStoreCode('肯德基T1店')).toBe('肯德基T1店');
      expect(cleanInternalStoreCode('肯德基 24h 店')).toBe('肯德基 24h 店');
    });

    it('keeps brand name with parenthesized store', () => {
      expect(cleanInternalStoreCode('肯德基（绿地缤纷城店）')).toBe('肯德基（绿地缤纷城店）');
    });

    it('passes null/undefined/empty through', () => {
      expect(cleanInternalStoreCode(null)).toBeNull();
      expect(cleanInternalStoreCode(undefined)).toBeNull();
      expect(cleanInternalStoreCode('')).toBe('');
      expect(cleanInternalStoreCode('   ')).toBe('');
    });

    it('falls back to original if cleaning would empty the name', () => {
      // 整段都是 -数字 的边缘情况：保留原文兜底
      expect(cleanInternalStoreCode('-1234-')).toBe('-1234-');
    });
  });
});

describe('normalizeStoreNameForAgent', () => {
  it('chains internal-code strip then city-prefix strip', () => {
    // "奥乐齐-1084 上海苏宁广场" + city="上海"
    // → 先剥内部编码 "奥乐齐 上海苏宁广场" → 再剥城市前缀 "奥乐齐 苏宁广场"（前缀剥除后留连接符已 trim）
    const result = normalizeStoreNameForAgent('上海奥乐齐-1084苏宁广场', '上海');
    // 'cleanInternalStoreCode' 处理后变 '上海奥乐齐苏宁广场'，stripCityPrefix 再剥 '上海' → '奥乐齐苏宁广场'
    expect(result).toBe('奥乐齐苏宁广场');
  });

  it('strips internal code only when city prefix absent', () => {
    expect(normalizeStoreNameForAgent('奥乐齐-1084奉贤苏宁广场', null)).toBe('奥乐齐奉贤苏宁广场');
  });

  it('passes through clean names untouched', () => {
    expect(normalizeStoreNameForAgent('肯德基（绿地缤纷城店）', '上海')).toBe(
      '肯德基（绿地缤纷城店）',
    );
  });

  it('handles null storeName', () => {
    expect(normalizeStoreNameForAgent(null, '上海')).toBeNull();
  });
});

import {
  hasMeaningfulValue,
  isSameFactValue,
  mergeNullableStringArrays,
  shouldAdoptRuleMeta,
} from '@memory/facts/fact-merge.util';

describe('fact-merge.util', () => {
  describe('hasMeaningfulValue', () => {
    it('null/undefined 视为无值', () => {
      expect(hasMeaningfulValue(null)).toBe(false);
      expect(hasMeaningfulValue(undefined)).toBe(false);
    });

    it('布尔值（含 false）视为有值', () => {
      expect(hasMeaningfulValue(true)).toBe(true);
      expect(hasMeaningfulValue(false)).toBe(true);
    });

    it('空串与纯空白字符串视为无值', () => {
      expect(hasMeaningfulValue('')).toBe(false);
      expect(hasMeaningfulValue('   ')).toBe(false);
      expect(hasMeaningfulValue('\t\n')).toBe(false);
    });

    it('非空字符串视为有值', () => {
      expect(hasMeaningfulValue('张三')).toBe(true);
      expect(hasMeaningfulValue(' a ')).toBe(true);
    });

    it('空数组视为无值，非空数组有值', () => {
      expect(hasMeaningfulValue([])).toBe(false);
      expect(hasMeaningfulValue(['瑞幸'])).toBe(true);
    });

    it('数字与对象视为有值（含 0）', () => {
      expect(hasMeaningfulValue(0)).toBe(true);
      expect(hasMeaningfulValue(25)).toBe(true);
      expect(hasMeaningfulValue({})).toBe(true);
    });
  });

  describe('isSameFactValue', () => {
    it('数组比较顺序无关', () => {
      expect(isSameFactValue(['a', 'b'], ['b', 'a'])).toBe(true);
      expect(isSameFactValue(['瑞幸', '库迪'], ['库迪', '瑞幸'])).toBe(true);
    });

    it('数组比较忽略首尾空白与空元素', () => {
      expect(isSameFactValue([' a ', 'b'], ['b', 'a'])).toBe(true);
      expect(isSameFactValue(['a', ''], ['a'])).toBe(true);
    });

    it('数组元素不同则不相等', () => {
      expect(isSameFactValue(['a'], ['a', 'b'])).toBe(false);
      expect(isSameFactValue(['a'], ['c'])).toBe(false);
    });

    it('字符串比较忽略首尾空白', () => {
      expect(isSameFactValue(' 张三 ', '张三')).toBe(true);
      expect(isSameFactValue('张三', '李四')).toBe(false);
    });

    it('任一侧为字符串时按字符串语义比较（string/非 string 混合）', () => {
      expect(isSameFactValue('25', 25)).toBe(true);
      expect(isSameFactValue(25, '25')).toBe(true);
      expect(isSameFactValue('true', true)).toBe(true);
      expect(isSameFactValue('26', 25)).toBe(false);
    });

    it('非字符串标量与对象按 JSON 序列化比较', () => {
      expect(isSameFactValue(25, 25)).toBe(true);
      expect(isSameFactValue(true, true)).toBe(true);
      expect(isSameFactValue(true, false)).toBe(false);
      expect(isSameFactValue({ a: 1 }, { a: 1 })).toBe(true);
      expect(isSameFactValue({ a: 1 }, { a: 2 })).toBe(false);
      expect(isSameFactValue(null, null)).toBe(true);
    });

    it('数组与非数组（非字符串）不相等', () => {
      expect(isSameFactValue(['a'], { 0: 'a' })).toBe(false);
    });
  });

  describe('mergeNullableStringArrays', () => {
    it('两侧均为 null/undefined 时返回 null', () => {
      expect(mergeNullableStringArrays(null, null)).toBeNull();
      expect(mergeNullableStringArrays(undefined, undefined)).toBeNull();
      expect(mergeNullableStringArrays(null, undefined)).toBeNull();
    });

    it('单侧为 null/undefined 时返回另一侧内容', () => {
      expect(mergeNullableStringArrays(['a'], null)).toEqual(['a']);
      expect(mergeNullableStringArrays(undefined, ['b'])).toEqual(['b']);
    });

    it('空数组与 null 混合时返回 null', () => {
      expect(mergeNullableStringArrays([], null)).toBeNull();
      expect(mergeNullableStringArrays([], [])).toBeNull();
    });

    it('合并并去重，保留首次出现顺序', () => {
      expect(mergeNullableStringArrays(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
      expect(mergeNullableStringArrays(['瑞幸'], ['瑞幸'])).toEqual(['瑞幸']);
    });
  });

  describe('shouldAdoptRuleMeta', () => {
    it('rule 值无意义时不采用（null/空串/空数组）', () => {
      expect(shouldAdoptRuleMeta('张三', null)).toBe(false);
      expect(shouldAdoptRuleMeta('张三', '')).toBe(false);
      expect(shouldAdoptRuleMeta('张三', [])).toBe(false);
      expect(shouldAdoptRuleMeta(null, undefined)).toBe(false);
    });

    it('当前值无意义、rule 值有意义时采用（rule 补位）', () => {
      expect(shouldAdoptRuleMeta(null, '张三')).toBe(true);
      expect(shouldAdoptRuleMeta(undefined, ['瑞幸'])).toBe(true);
      expect(shouldAdoptRuleMeta('', '13800000000')).toBe(true);
      expect(shouldAdoptRuleMeta([], ['a'])).toBe(true);
    });

    it('值相同时采用 rule 元数据（即便来源不同，值一致即可贴 high/rule）', () => {
      expect(shouldAdoptRuleMeta('张三', '张三')).toBe(true);
      expect(shouldAdoptRuleMeta(' 张三 ', '张三')).toBe(true);
      expect(shouldAdoptRuleMeta(['a', 'b'], ['b', 'a'])).toBe(true);
      expect(shouldAdoptRuleMeta(25, '25')).toBe(true);
    });

    it('当前值有意义且与 rule 不同时保留 LLM 元数据（返回 false）', () => {
      expect(shouldAdoptRuleMeta('李四', '张三')).toBe(false);
      expect(shouldAdoptRuleMeta(['a'], ['b'])).toBe(false);
      expect(shouldAdoptRuleMeta(26, '25')).toBe(false);
    });

    it('布尔 false 是有意义的当前值，与 rule 值不同时不被覆盖', () => {
      expect(shouldAdoptRuleMeta(false, true)).toBe(false);
      expect(shouldAdoptRuleMeta(false, false)).toBe(true);
    });
  });
});

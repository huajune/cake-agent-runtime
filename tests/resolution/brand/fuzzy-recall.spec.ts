import { findBrandFuzzyMatches } from '@resolution/brand/fuzzy-recall';

describe('findBrandFuzzyMatches', () => {
  describe('badcase batch_6a0c074c536c9654029b6930 — 刘姐妹 ↔ 成都你六姐', () => {
    it('catches "刘姐妹" as homophone of "成都你六姐" (shares 姐 + pinyin liu/jie)', () => {
      const matches = findBrandFuzzyMatches(['刘姐妹'], ['成都你六姐', '奥乐齐']);
      expect(matches).toHaveLength(1);
      expect(matches[0].brandName).toBe('成都你六姐');
      expect(matches[0].sharedChars).toEqual(['姐']);
      expect(matches[0].sharedPinyin.sort()).toEqual(['jie', 'liu']);
      expect(matches[0].pinyinOverlapRatio).toBeGreaterThanOrEqual(0.5);
    });

    it('does not match "刘姐妹" against unrelated brand "奥乐齐"', () => {
      const matches = findBrandFuzzyMatches(['刘姐妹'], ['奥乐齐']);
      expect(matches).toEqual([]);
    });
  });

  describe('typo / homophone variants', () => {
    it('matches "成都老六姐" → "成都你六姐" (3 shared chars, 4/5 pinyin overlap)', () => {
      const matches = findBrandFuzzyMatches(['成都老六姐'], ['成都你六姐']);
      expect(matches).toHaveLength(1);
      expect(matches[0].brandName).toBe('成都你六姐');
      expect(matches[0].sharedChars.sort()).toEqual(['六', '姐', '成', '都']);
    });

    it('matches "肯德鸡" → "肯德基" (2 shared chars + 同音 ji/ji)', () => {
      const matches = findBrandFuzzyMatches(['肯德鸡'], ['肯德基']);
      expect(matches).toHaveLength(1);
      expect(matches[0].brandName).toBe('肯德基');
      expect(matches[0].sharedChars.sort()).toEqual(['德', '肯']);
    });

    it('matches "麦当当" → "麦当劳" via 2 shared chars + pinyin overlap', () => {
      const matches = findBrandFuzzyMatches(['麦当当'], ['麦当劳']);
      expect(matches).toHaveLength(1);
      expect(matches[0].brandName).toBe('麦当劳');
    });
  });

  describe('safety: no false positives when zero shared chars', () => {
    it('rejects pure homophone with 0 shared characters', () => {
      // "肯德基" 和 "啃得鸡" 完全同音但 0 共享汉字
      const matches = findBrandFuzzyMatches(['啃得鸡'], ['肯德基']);
      expect(matches).toEqual([]);
    });

    it('rejects single-char input vs single-char brand sharing nothing', () => {
      const matches = findBrandFuzzyMatches(['茶'], ['饭']);
      expect(matches).toEqual([]);
    });

    it('skips exact-equal alias (not "fuzzy" if literal match)', () => {
      const matches = findBrandFuzzyMatches(['肯德基'], ['肯德基', '麦当劳']);
      expect(matches).toEqual([]);
    });
  });

  describe('input variations', () => {
    it('returns empty when brandAliasList is empty', () => {
      const matches = findBrandFuzzyMatches([], ['成都你六姐']);
      expect(matches).toEqual([]);
    });

    it('returns empty when brand pool is empty', () => {
      const matches = findBrandFuzzyMatches(['刘姐妹'], []);
      expect(matches).toEqual([]);
    });

    it('dedupes brand pool entries', () => {
      const matches = findBrandFuzzyMatches(
        ['刘姐妹'],
        ['成都你六姐', '成都你六姐', ' 成都你六姐 '],
      );
      expect(matches.filter((m) => m.brandName === '成都你六姐')).toHaveLength(1);
    });

    it('processes multiple aliases and ranks by score', () => {
      const matches = findBrandFuzzyMatches(['刘姐妹', '成都老六姐'], ['成都你六姐', '奥乐齐']);
      expect(matches).toHaveLength(1);
      expect(matches[0].brandName).toBe('成都你六姐');
      // 成都老六姐（4 共享字 + 4/5 拼音）应该比 刘姐妹（1 共享字 + 2/3 拼音）分高
      expect(matches[0].inputAlias).toBe('成都老六姐');
    });

    it('respects topK option (cap on returned matches)', () => {
      const matches = findBrandFuzzyMatches(['刘姐妹', '六姐'], ['成都你六姐', '小六姐妹店'], {
        topK: 1,
      });
      expect(matches.length).toBeLessThanOrEqual(1);
    });

    it('respects sharedCharsMin option', () => {
      // 提高门槛：要求至少 2 个共享汉字才算匹配
      const matches = findBrandFuzzyMatches(['刘姐妹'], ['成都你六姐'], { sharedCharsMin: 2 });
      expect(matches).toEqual([]);
    });

    it('respects pinyinOverlapMin option', () => {
      // 提高拼音重叠阈值到 0.9，原本 2/3≈0.667 的"刘姐妹↔成都你六姐"应被淘汰
      const matches = findBrandFuzzyMatches(['刘姐妹'], ['成都你六姐'], { pinyinOverlapMin: 0.9 });
      expect(matches).toEqual([]);
    });
  });

  describe('result shape', () => {
    it('exposes score / pinyinOverlapRatio / sharedChars / sharedPinyin / inputAlias / brandName', () => {
      const matches = findBrandFuzzyMatches(['刘姐妹'], ['成都你六姐']);
      expect(matches).toHaveLength(1);
      const m = matches[0];
      expect(typeof m.score).toBe('number');
      expect(m.score).toBeGreaterThan(0);
      expect(m.score).toBeLessThanOrEqual(1);
      expect(typeof m.pinyinOverlapRatio).toBe('number');
      expect(Array.isArray(m.sharedChars)).toBe(true);
      expect(Array.isArray(m.sharedPinyin)).toBe(true);
      expect(m.inputAlias).toBe('刘姐妹');
      expect(m.brandName).toBe('成都你六姐');
    });
  });
});

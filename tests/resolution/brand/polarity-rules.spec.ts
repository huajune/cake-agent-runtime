import {
  detectGlobalBrandControls,
  isBrandSpanHistoryContext,
  isBrandSpanNegated,
  splitClauses,
  stripPolarityControlWords,
} from '@resolution/brand/polarity-rules';

describe('polarity-rules', () => {
  it('detects browse-all and current-brand rejection controls', () => {
    expect(detectGlobalBrandControls('品牌不限')).toEqual([
      { polarity: 'browse_all', matchedText: '品牌不限' },
    ]);
    expect(detectGlobalBrandControls('这家算了')).toEqual([
      { polarity: 'negative', matchedText: '这家算了' },
    ]);
    expect(detectGlobalBrandControls('随便')).toEqual([]);
  });

  it('detects preceding and following negation without treating questions as rejection', () => {
    expect(isBrandSpanNegated('不要肯德基', 2, 3)).toBe(true);
    expect(isBrandSpanNegated('肯德基算了', 0, 3)).toBe(true);
    expect(isBrandSpanNegated('要不要肯德基', 3, 3)).toBe(false);
    expect(isBrandSpanNegated('肯德基可以', 0, 3)).toBe(false);
  });

  it('strips control words and splits independent punctuation clauses', () => {
    expect(stripPolarityControlWords('除了肯德基都可以')).toBe('肯德基');
    expect(splitClauses('肯德基不要，麦当劳可以；M Stand也行')).toEqual([
      '肯德基不要',
      '麦当劳可以',
      'M Stand也行',
    ]);
  });
});

describe('isBrandSpanHistoryContext（2026-07-27 履历语境，三例生产实证）', () => {
  it('后置时长体："优衣库的话有做三个月左右"', () => {
    expect(isBrandSpanHistoryContext('优衣库的话有做三个月左右', 0, 3)).toBe(true);
  });

  it('前置"刚从" + 后置离职体："刚从盒马鲜生做分拣离职"', () => {
    // 盒马鲜生 span 起点 2、长度 4，前窗"刚从"与后窗"做分拣离职"任一命中即可
    expect(isBrandSpanHistoryContext('刚从盒马鲜生做分拣离职捂脸', 2, 4)).toBe(true);
  });

  it('后置完成体："生鲜超市做过理货和补货"', () => {
    expect(isBrandSpanHistoryContext('生鲜超市做过理货和补货', 0, 4)).toBe(true);
  });

  it('前置"之前在"："之前在肯德基上过班"', () => {
    expect(isBrandSpanHistoryContext('之前在肯德基上过班', 3, 3)).toBe(true);
  });

  it('求职表达不误伤："肯德基做兼职可以吗" / "想去必胜客上班"', () => {
    expect(isBrandSpanHistoryContext('肯德基做兼职可以吗', 0, 3)).toBe(false);
    expect(isBrandSpanHistoryContext('想去必胜客上班', 2, 3)).toBe(false);
  });

  it('无关的"从"不误伤："从苏州过来想找肯德基"', () => {
    expect(isBrandSpanHistoryContext('从苏州过来想找肯德基', 7, 3)).toBe(false);
  });
});

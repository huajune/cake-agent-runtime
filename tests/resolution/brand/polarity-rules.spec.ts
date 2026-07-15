import {
  detectGlobalBrandControls,
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

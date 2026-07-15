import {
  buildExactMatchTokens,
  normalizeForBrandMatch,
  stripBrandNoisePatterns,
} from '@resolution/brand/brand-normalize';

describe('brand-normalize', () => {
  it('normalizes case, whitespace and separators for matching', () => {
    expect(normalizeForBrandMatch(' M.A.C－咖啡 ')).toBe('mac咖啡');
    expect(normalizeForBrandMatch(null)).toBe('');
  });

  it('strips recruiting noise without changing the original display value', () => {
    expect(stripBrandNoisePatterns('我想找肯德基兼职岗位')).toBe('肯德基');
  });

  it('builds unique exact-match tokens from the whole message and conjunction parts', () => {
    expect(buildExactMatchTokens('想找肯德基和麦当劳兼职')).toEqual(
      expect.arrayContaining(['想找肯德基和麦当劳兼职', '肯德基和麦当劳', '肯德基', '麦当劳']),
    );
    expect(buildExactMatchTokens('')).toEqual([]);
  });
});

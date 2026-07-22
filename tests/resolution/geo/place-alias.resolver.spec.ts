import { hasGenericAmbiguousSuffix, resolveCityFromLocation } from '@resolution/geo';

describe('resolution/geo places（Phase 0 golden cases 平移）', () => {
  it('golden：陆家嘴 → 上海；光谷 → 武汉', () => {
    expect(resolveCityFromLocation('陆家嘴')).toBe('上海');
    expect(resolveCityFromLocation('光谷')).toBe('武汉');
  });

  it('通用商业体不入地标白名单（万达广场走歧义黑名单）', () => {
    expect(resolveCityFromLocation('万达广场')).toBeNull();
    expect(hasGenericAmbiguousSuffix('万达广场')).toBe(true);
  });

  it('地标名内部空白归一后仍可命中', () => {
    expect(resolveCityFromLocation('陆 家 嘴')).toBe('上海');
  });
});

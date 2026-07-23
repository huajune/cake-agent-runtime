import type { BrandItem } from '@/sponge/sponge.types';
import {
  buildBrandCatalogIndex,
  distinctBrandsOf,
  isBrandContainEligible,
  isShortLatinBoundaryEligible,
} from '@resolution/brand/catalog-index';

describe('catalog-index', () => {
  const catalog: BrandItem[] = [
    { id: 1, name: '肯德基', aliases: ['KFC', '炸鸡店'] },
    { id: 2, name: '瑞幸咖啡', aliases: ['瑞幸', '咖啡'] },
    { id: 3, name: '拉瓦萨', aliases: ['lavazza'] },
    { id: 4, name: '来伊份', aliases: ['来一份'] },
    { id: 5, name: '小龙坎', aliases: ['小龙'] },
    { id: 6, name: '小龙翻大江', aliases: ['小龙'] },
    { id: 10024, name: '跃橙云服', aliases: ['跃橙云服人力资源'] },
  ];

  it('classifies safe contains and short latin boundary aliases', () => {
    expect(isBrandContainEligible('炸鸡店')).toBe(true);
    expect(isBrandContainEligible('来一份')).toBe(false);
    expect(isBrandContainEligible('mc')).toBe(false);
    expect(isShortLatinBoundaryEligible('kfc')).toBe(true);
    expect(isShortLatinBoundaryEligible('mstand')).toBe(false);
  });

  it('indexes ids, conflicts and categories while reserving generic category aliases', () => {
    const index = buildBrandCatalogIndex(catalog);

    expect(index.byBrandId.get(1)?.name).toBe('肯德基');
    expect(index.brandIdByName.get('瑞幸咖啡')).toBe(2);
    expect(index.byNormalized.get('小龙')).toHaveLength(2);
    expect(index.byNormalized.has('咖啡')).toBe(false);
    expect(index.byNormalized.has('跃橙云服')).toBe(false);
    expect(index.byBrandId.get(10024)?.name).toBe('跃橙云服');
    expect(index.brandIdByName.get('跃橙云服')).toBe(10024);
    expect(index.nonEmployerBrandIds).toContain(10024);
    expect(index.categories.find((item) => item.label === '咖啡')?.brands.sort()).toEqual([
      '拉瓦萨',
      '瑞幸咖啡',
    ]);
    expect(index.candidates[0].normalized.length).toBeGreaterThanOrEqual(
      index.candidates.at(-1)?.normalized.length ?? 0,
    );
  });

  it('memoizes by catalog reference and deduplicates conflicting entries by brand', () => {
    const first = buildBrandCatalogIndex(catalog);
    expect(buildBrandCatalogIndex(catalog)).toBe(first);
    expect(buildBrandCatalogIndex([...catalog])).not.toBe(first);

    const entries = first.byNormalized.get('小龙') ?? [];
    expect(distinctBrandsOf([...entries, entries[0]])).toEqual([
      { brandName: '小龙坎', brandId: 5 },
      { brandName: '小龙翻大江', brandId: 6 },
    ]);
  });
});

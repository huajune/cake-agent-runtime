import type { BrandItem } from '@/sponge/sponge.types';
import {
  buildResolvedCategories,
  matchCategories,
  resolveCategoryBrands,
  type BrandCategory,
} from '@resolution/brand/category-expansion';

describe('category-expansion', () => {
  const catalog: BrandItem[] = [
    { id: 1, name: '瑞幸咖啡', aliases: ['luckin'] },
    { id: 2, name: '拉瓦萨', aliases: [] },
    { id: 3, name: '得闲饮茶', aliases: ['奶茶'] },
  ];

  it('combines keyword matches and extras, then removes explicit exclusions', () => {
    const category: BrandCategory = {
      label: '咖啡',
      keywords: ['咖啡', 'coffee'],
      extraBrands: ['拉瓦萨', '目录不存在'],
      excludeBrands: ['得闲饮茶'],
    };

    expect(resolveCategoryBrands(category, catalog).sort()).toEqual(['拉瓦萨', '瑞幸咖啡']);
  });

  it('builds only non-empty configured categories and matches normalized text', () => {
    const categories = buildResolvedCategories(catalog);
    expect(categories).toHaveLength(1);
    expect(matchCategories('我想找coffee兼职', categories)).toEqual([
      { category: categories[0], matchedKeyword: 'coffee' },
    ]);
    expect(matchCategories('我想找餐饮兼职', categories)).toEqual([]);
  });
});

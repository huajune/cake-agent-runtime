import type { BrandItem } from '@/sponge/sponge.types';
import { normalizeForBrandMatch } from '@resolution/brand/brand-normalize';
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
      { category: categories[0], matchedKeyword: 'coffee', matchedIndex: 3 },
    ]);
    expect(matchCategories('我想找餐饮兼职', categories)).toEqual([]);
  });

  describe('工种后缀护栏：品类词 ≠ 工种称谓', () => {
    const categories = buildResolvedCategories(catalog);
    const match = (raw: string) => matchCategories(normalizeForBrandMatch(raw), categories);

    it.each([
      ['我面试咖啡师'],
      ['咖啡师'],
      ['应聘岗位：长期晚班咖啡师'],
      ['想做咖啡学徒'],
      ['接受无咖啡师经验'],
    ])('工种称谓不进品类通道：%s', (raw) => {
      expect(match(raw)).toEqual([]);
    });

    it.each([
      ['附近有合适的咖啡店招人吗'],
      ['咖啡品牌'],
      ['有兼职咖啡店的吗'],
      ['咖啡 番禺四海城'],
    ])('真品类意图仍然命中：%s', (raw) => {
      expect(match(raw)).toHaveLength(1);
    });

    it('同一句里工种词在前、品类词在后时，仍按品类命中且位置指向品类词', () => {
      // 只看首个出现会锚到"咖啡师"，导致整句被判成工种而漏掉真实的品类意图。
      const hits = match('做咖啡师也行，主要想找咖啡店');
      expect(hits).toHaveLength(1);
      expect(hits[0].matchedKeyword).toBe('咖啡');
      // 命中位置必须是"咖啡店"那次出现，而不是句首的"咖啡师"。
      expect(
        normalizeForBrandMatch('做咖啡师也行，主要想找咖啡店').slice(hits[0].matchedIndex),
      ).toBe('咖啡店');
    });
  });
});

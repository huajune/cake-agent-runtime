/**
 * 品类（行业）展开 —— 迁移自 memory/facts/high-confidence-facts.ts 的品类兜底段。
 *
 * 真实场景中候选人说"咖啡"等品类词，指的是**该品类的相关品牌**（想去咖啡店），
 * 而不是"咖啡师"这个工种。因此命中品类词时，应展开为该品类下的全部品牌走品牌召回，
 * 不能窄化成 jobCategoryList=["咖啡师"]。
 *
 * 展开结果仅当轮查询扩展（多品牌 enforce 召回），不写入会话主品牌、不解除排斥（§6.2/§9.3）；
 * 品类查询列表须先减去会话 excludedBrands（由消费方执行，本模块无状态）。
 */

import type { BrandItem } from '@/sponge/sponge.types';
import { normalizeForBrandMatch } from './brand-normalize';

/**
 * 品类配置。
 *
 * 成员品牌的解析规则（见 resolveCategoryBrands）：
 *   名称/别名（归一化后）包含 keywords 任一的品牌（数据驱动，新品牌自动纳入）
 *   ∪ extraBrands（名字不含品类词但确属该品类，如「拉瓦萨」是咖啡品牌但名称无"咖啡"）
 *   − excludeBrands（名字含关键词但其实不属该品类，如早茶店"得闲饮茶"不是奶茶）
 *
 * keywords 同时用于：① 识别用户消息里的品类意图；② 从品牌库筛选成员品牌。
 *
 * 注意：只收录已人工核对过的品类。奶茶/火锅等品类纯靠子串会误纳（如"得闲饮茶"是早茶
 * 而非奶茶），需逐一核对 extraBrands/excludeBrands 后再开启，避免召回噪音。
 */
export interface BrandCategory {
  /** 品类显示名，用于 evidence/日志 */
  label: string;
  /** 触发词 & 成员筛选词（原文，匹配时统一归一化） */
  keywords: string[];
  /** 名字不含品类词但确属该品类的品牌，手工补录 */
  extraBrands: string[];
  /** 名字含关键词但实际不属该品类的品牌，手工排除 */
  excludeBrands: string[];
}

export const BRAND_CATEGORIES: BrandCategory[] = [
  {
    label: '咖啡',
    keywords: ['咖啡', 'coffee'],
    extraBrands: ['拉瓦萨'],
    excludeBrands: [],
  },
];

/**
 * 所有品类关键词的归一化集合。
 * 这些词被"预留"给品类展开，不再作为单一品牌的别称参与精确匹配——
 * 否则像 Tims咖啡 把泛词"咖啡"挂成自己别称，会导致"咖啡"被错配成单一品牌。
 */
export const CATEGORY_KEYWORD_NORMALIZED = new Set(
  BRAND_CATEGORIES.flatMap((category) =>
    category.keywords.map((keyword) => normalizeForBrandMatch(keyword)).filter(Boolean),
  ),
);

export interface ResolvedBrandCategory {
  label: string;
  /** 归一化后的触发词 */
  keywords: string[];
  /** 该品类下的成员品牌标准名 */
  brands: string[];
}

/** 按品牌库解析每个品类的成员品牌（数据驱动 + 手工补录/排除）。 */
export function resolveCategoryBrands(category: BrandCategory, brandData: BrandItem[]): string[] {
  const keywords = category.keywords.map((k) => normalizeForBrandMatch(k)).filter(Boolean);
  const brands = new Set<string>();

  for (const brand of brandData) {
    const fields = [brand.name, ...(brand.aliases ?? [])].map((v) => normalizeForBrandMatch(v));
    if (fields.some((field) => keywords.some((kw) => field.includes(kw)))) {
      brands.add(brand.name);
    }
  }
  for (const extra of category.extraBrands) {
    if (brandData.some((brand) => brand.name === extra)) brands.add(extra);
  }
  for (const excluded of category.excludeBrands) {
    brands.delete(excluded);
  }

  return Array.from(brands);
}

export function buildResolvedCategories(brandData: BrandItem[]): ResolvedBrandCategory[] {
  return BRAND_CATEGORIES.map((category) => ({
    label: category.label,
    keywords: category.keywords.map((k) => normalizeForBrandMatch(k)).filter(Boolean),
    brands: resolveCategoryBrands(category, brandData),
  })).filter((category) => category.keywords.length > 0 && category.brands.length > 0);
}

/** 归一化文本中命中的品类（供解析管线在"未命中任何具体品牌"时展开）。 */
export function matchCategories(
  normalizedText: string,
  categories: ResolvedBrandCategory[],
): Array<{ category: ResolvedBrandCategory; matchedKeyword: string }> {
  const hits: Array<{ category: ResolvedBrandCategory; matchedKeyword: string }> = [];
  for (const category of categories) {
    const matchedKeyword = category.keywords.find((keyword) => normalizedText.includes(keyword));
    if (matchedKeyword) hits.push({ category, matchedKeyword });
  }
  return hits;
}

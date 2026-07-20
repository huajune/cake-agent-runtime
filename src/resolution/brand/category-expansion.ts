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

/**
 * 品类命中一律展开为**该品类的全部品牌**，不设"业务默认品牌"。
 *
 * 历史教训：v10.15.0（2026-07-16）曾引入 `defaultBrand: 'M Stand'`，令"咖啡"只出
 * M Stand、其余 9 个咖啡品牌需候选人主动说"还有别的吗"才展开。该方案是规格外的，
 * 规格 §17 注记明写"尚未合入 develop，评审时一并裁定"，实际却搭一个标题无关的 PR
 * 合入并随热修上线，裁定从未发生。2026-07-20 产品裁定：撤除，回到全展开。
 * 若日后要重开默认品牌，必须先过评审并同步规格，不要只改这里一行。
 */
export const BRAND_CATEGORIES: BrandCategory[] = [
  {
    label: '咖啡',
    keywords: ['咖啡', 'coffee'],
    extraBrands: ['M Stand', '拉瓦萨'],
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

/**
 * 工种后缀：品类词紧跟这些字时是**工种称谓**（"咖啡师""咖啡学徒"）而非品类意图（"咖啡店"），
 * 不进品类通道。这正是本文件开头所述"候选人说的是品类而不是『咖啡师』这个工种"的护栏——
 * 缺了它，候选人报名表里的"应聘岗位：长期晚班咖啡师"会被读成品类信号，把已确立的
 * currentBrand 改写成品类默认品牌（生产实例 6a5dbfa7：报名拉瓦萨途中翻成 M Stand）。
 */
const OCCUPATION_SUFFIXES = ['师', '学徒'];

/**
 * 返回品类词在文本中首个**非工种语境**的出现位置；全部出现都是工种称谓时返回 -1。
 * 逐个出现位扫描而非只看首个，保证"想找咖啡店，做咖啡师也行"仍按品类命中。
 */
function findCategoryKeywordIndex(normalizedText: string, keyword: string): number {
  let index = normalizedText.indexOf(keyword);
  while (index >= 0) {
    const following = normalizedText.slice(index + keyword.length);
    if (!OCCUPATION_SUFFIXES.some((suffix) => following.startsWith(suffix))) return index;
    index = normalizedText.indexOf(keyword, index + keyword.length);
  }
  return -1;
}

/** 归一化文本中命中的品类（供解析管线在"未命中任何具体品牌"时展开）。 */
export function matchCategories(
  normalizedText: string,
  categories: ResolvedBrandCategory[],
): Array<{ category: ResolvedBrandCategory; matchedKeyword: string; matchedIndex: number }> {
  const hits: Array<{
    category: ResolvedBrandCategory;
    matchedKeyword: string;
    matchedIndex: number;
  }> = [];
  for (const category of categories) {
    for (const keyword of category.keywords) {
      const matchedIndex = findCategoryKeywordIndex(normalizedText, keyword);
      if (matchedIndex >= 0) {
        hits.push({ category, matchedKeyword: keyword, matchedIndex });
        break;
      }
    }
  }
  return hits;
}

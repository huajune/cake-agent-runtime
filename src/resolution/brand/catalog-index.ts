/**
 * 品牌目录索引 —— 迁移自 memory/facts/high-confidence-facts.ts 的 getBrandMatchAssets
 * （改名归位，非新概念），在旧候选表基础上补充解析管线需要的检索结构（§7.1）：
 *
 * - brandId → 品牌
 * - 标准名/别名归一化值 → 一个或多个品牌（冲突别名可检出）
 * - 可安全做包含匹配的长别名集合（containEligible）
 * - 品类展开配置（category-expansion）
 *
 * 索引按 brandData 数组引用 memoize：brandData 来自 SpongeService 的 30 分钟缓存，
 * 引用在缓存有效期内稳定；避免每轮对全量品牌做 normalize + sort 的纯 CPU 浪费。
 */

import type { BrandItem } from '@/sponge/sponge.types';
import { normalizeForBrandMatch } from './brand-normalize';
import {
  buildResolvedCategories,
  CATEGORY_KEYWORD_NORMALIZED,
  type ResolvedBrandCategory,
} from './category-expansion';

/**
 * 通用短语别称黑名单（归一化形态）：这些别称虽然长度达标，但本身是日常用语/同音词，
 * 做子串包含会把普通句子误判为品牌意向（如 "给我来一份工作" 命中 来伊份 的别称 "来一份"）。
 * 命中黑名单的别称降级为仅全等匹配——用户单独说 "来一份" 仍能命中，嵌在句子里则不命中。
 */
export const BRAND_GENERIC_ALIAS_BLOCKLIST = new Set([
  '来一份',
  '来1份',
  // 品类/业态泛词被运营录成单一品牌别名（如 7-11 的"便利店"）：句中包含必误判，降级为仅全等。
  '便利店',
]);

/**
 * 非标准名别名的最短归一化长度：<2 一律不参与任何匹配。
 *
 * 品牌库存在 17 个 1 字符别名（"报""捞""红""匠"…含全角塌缩产物），单字词形在中文
 * 对话里是纯噪音源——即使只做全等 token 匹配，分句后独立成 token 的单字（"姐，…"）
 * 也会高频误命中（2026-07-16 生产事故）。品牌标准名本身不受此限（单字品牌如"匠"
 * 仍可被整句全等命中）。
 */
export const MIN_ALIAS_NORMALIZED_LENGTH = 2;

/**
 * 别称是否长到可以安全地做子串包含匹配（中文 ≥3 字、英文 ≥4 字，黑名单除外）。
 * 纯数字别名一律不做无边界子串包含——"10200" 这类 ID 型别名嵌在手机号/时间串里
 * 必然巧合命中，数字别名只允许全等 token 或带边界的短词包含。
 */
export function isBrandContainEligible(normalized: string): boolean {
  if (BRAND_GENERIC_ALIAS_BLOCKLIST.has(normalized)) return false;
  if (/^[0-9]+$/.test(normalized)) return false;
  const isCjk = /[一-龥]/.test(normalized);
  return isCjk ? normalized.length >= 3 : normalized.length >= 4;
}

/**
 * 短英文/数字别名是否可做 token 边界包含匹配（§7.3）：
 * 匹配片段前后必须不是英数字符（即处于 CJK/边界处），"kfc松江" 命中而 "mcm" 不命中 "mc"。
 * 短中文别名不参与任何包含匹配（只走全等 token）。
 * 纯数字别名要求 ≥3 位（"711" 可边界包含；"71" 在 "玫瑰街71号" 这类门牌/时间串场景
 * 全是巧合命中，只留全等 token）。
 */
export function isShortLatinBoundaryEligible(normalized: string): boolean {
  if (BRAND_GENERIC_ALIAS_BLOCKLIST.has(normalized)) return false;
  if (/^[0-9]+$/.test(normalized)) return /^[0-9]{3}$/.test(normalized);
  return /^[a-z0-9]{2,3}$/.test(normalized);
}

export interface BrandCatalogCandidate {
  brandName: string;
  brandId: number | null;
  alias: string;
  normalized: string;
  /** 该词条是否品牌标准名本身（决定 canonical_exact vs alias_exact 档位）。 */
  isCanonical: boolean;
  /** 是否允许长别名子串包含匹配。 */
  containEligible: boolean;
  /** 是否允许短英数别名的 token 边界包含匹配。 */
  shortLatinBoundaryEligible: boolean;
}

export interface BrandCatalogIndex {
  /** 全部候选词条，按归一化长度降序（长词优先）。 */
  candidates: BrandCatalogCandidate[];
  /** 归一化词形 → 词条列表（同词形对应多个品牌即冲突别名）。 */
  byNormalized: Map<string, BrandCatalogCandidate[]>;
  /** 品牌ID → 品牌（旧目录响应无 id 时该表为空）。 */
  byBrandId: Map<number, BrandItem>;
  /** 标准名 → 品牌ID（入口标准化时优先转 ID 用）。 */
  brandIdByName: Map<string, number>;
  /** 已解析的品类展开配置。 */
  categories: ResolvedBrandCategory[];
}

let indexCache: { source: BrandItem[]; index: BrandCatalogIndex } | null = null;

/** 构建（或复用缓存的）品牌目录索引。 */
export function buildBrandCatalogIndex(brandData: BrandItem[]): BrandCatalogIndex {
  if (indexCache && indexCache.source === brandData) {
    return indexCache.index;
  }

  const candidates: BrandCatalogCandidate[] = brandData
    .flatMap((brand) =>
      [
        { brand, alias: brand.name, isCanonical: true },
        ...(brand.aliases ?? []).map((alias) => ({ brand, alias, isCanonical: false })),
      ].map(({ brand: item, alias, isCanonical }) => {
        const normalized = normalizeForBrandMatch(alias);
        return {
          brandName: item.name,
          brandId: typeof item.id === 'number' ? item.id : null,
          alias,
          normalized,
          isCanonical,
          containEligible: isBrandContainEligible(normalized),
          shortLatinBoundaryEligible: isShortLatinBoundaryEligible(normalized),
        };
      }),
    )
    .filter(
      (candidate) =>
        // 预留品类词给品类展开：泛词别称（如 Tims咖啡 的别称"咖啡"）不参与单一品牌精确匹配；
        // 非标准名别名低于最短长度门槛（单字/塌缩词形）整体剔除，标准名只要求非空。
        candidate.normalized.length >= (candidate.isCanonical ? 1 : MIN_ALIAS_NORMALIZED_LENGTH) &&
        !CATEGORY_KEYWORD_NORMALIZED.has(candidate.normalized),
    )
    .sort((a, b) => b.normalized.length - a.normalized.length);

  const byNormalized = new Map<string, BrandCatalogCandidate[]>();
  for (const candidate of candidates) {
    const list = byNormalized.get(candidate.normalized);
    if (list) {
      list.push(candidate);
    } else {
      byNormalized.set(candidate.normalized, [candidate]);
    }
  }

  const byBrandId = new Map<number, BrandItem>();
  const brandIdByName = new Map<string, number>();
  for (const brand of brandData) {
    if (typeof brand.id === 'number') {
      byBrandId.set(brand.id, brand);
      brandIdByName.set(brand.name, brand.id);
    }
  }

  const index: BrandCatalogIndex = {
    candidates,
    byNormalized,
    byBrandId,
    brandIdByName,
    categories: buildResolvedCategories(brandData),
  };
  indexCache = { source: brandData, index };
  return index;
}

/** 词条集合去重后的品牌视图（同一词形对应多少个不同品牌）。 */
export function distinctBrandsOf(
  entries: BrandCatalogCandidate[],
): Array<{ brandName: string; brandId: number | null }> {
  const seen = new Map<string, { brandName: string; brandId: number | null }>();
  for (const entry of entries) {
    if (!seen.has(entry.brandName)) {
      seen.set(entry.brandName, { brandName: entry.brandName, brandId: entry.brandId });
    }
  }
  return Array.from(seen.values());
}

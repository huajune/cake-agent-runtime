/**
 * 品牌匹配主体 + 解析管线（迁移自 memory/facts/high-confidence-facts.ts 的
 * detectBrandAliasHints 匹配主体，新增置信度档位 / 极性 / 歧义 / 品牌ID 契约解析）。
 *
 * 核心导出为纯函数 resolveBrands(text, source, catalog)：单测直接注入目录，
 * 不需要 NestJS 容器；BrandResolutionService 只是薄封装（§6.5）。
 *
 * 匹配规则（§7.2/§7.3）：
 * - 品牌 ID（"品牌ID：10239" 格式契约）> 标准名精确 > 唯一别名精确 > 安全长别名包含
 * - 短中文别名只做全等 token 匹配；短英数别名（2-3 字符）允许 token 边界包含（"kfc松江"）
 * - 冲突别名标记歧义（ambiguous），不直接选择其中一个
 * - 品牌库对不上的词一律不当成品牌（查不到就不猜）
 */

import type { BrandItem } from '@/sponge/sponge.types';
import {
  BRAND_CONFIDENCE,
  truncateSourceText,
  type BrandCandidate,
  type BrandMatchType,
  type BrandResolution,
  type BrandResolutionSource,
} from './brand-resolution.types';
import { buildExactMatchTokens, normalizeForBrandMatch } from './brand-normalize';
import {
  buildBrandCatalogIndex,
  distinctBrandsOf,
  type BrandCatalogCandidate,
  type BrandCatalogIndex,
} from './catalog-index';
import { matchCategories } from './category-expansion';
import {
  detectGlobalBrandControls,
  isBrandSpanNegated,
  splitClauses,
  stripPolarityControlWords,
} from './polarity-rules';

/** 匹配方式的优先级（越小越优先，§7.2）。 */
const MATCH_TYPE_PRIORITY: Record<BrandMatchType, number> = {
  brand_id: 0,
  canonical_exact: 1,
  alias_exact: 2,
  alias_containment: 3,
  category_expansion: 4,
};

const CONFIDENCE_BY_MATCH_TYPE: Record<BrandMatchType, number> = {
  brand_id: BRAND_CONFIDENCE.brandId,
  canonical_exact: BRAND_CONFIDENCE.canonicalExact,
  alias_exact: BRAND_CONFIDENCE.aliasExact,
  alias_containment: BRAND_CONFIDENCE.aliasContainment,
  category_expansion: BRAND_CONFIDENCE.categoryExpansion,
};

/** "品牌ID：10239" 行的格式契约（两侧 prompt 已约定，§10.4）。 */
const BRAND_ID_CONTRACT_REGEX = /品牌\s*ID\s*[：:]\s*(\d{1,10})/gi;

interface ClauseMatch {
  entries: BrandCatalogCandidate[];
  matchType: Extract<BrandMatchType, 'canonical_exact' | 'alias_exact' | 'alias_containment'>;
  matchedText: string;
  /** 命中所在子句的用户原文（归因用，见 BrandResolution.sourceText）。 */
  sourceText: string;
  negated: boolean;
}

/**
 * 解析一段文本中的品牌信号（无状态纯函数）。
 *
 * 返回带来源标签的候选品牌信号列表；跨来源合并与状态写入由调用方负责（§7.5）。
 */
export function resolveBrands(
  text: string | null | undefined,
  source: BrandResolutionSource,
  catalog: BrandItem[],
): BrandResolution[] {
  const trimmed = text?.trim();
  if (!trimmed || catalog.length === 0) return [];

  const index = buildBrandCatalogIndex(catalog);
  const results: BrandResolution[] = [];

  // 1. 品牌 ID 契约行（图片描述为主，任何来源出现均认）。
  const idResolutions = resolveBrandIdMentions(trimmed, source, index);
  results.push(...idResolutions);

  // 2. 全局品牌控制（browse_all / 品牌为空的 negative）。昵称不是意图表达，跳过。
  if (source !== 'contact_name') {
    for (const control of detectGlobalBrandControls(trimmed)) {
      results.push({
        canonicalName: null,
        brandId: null,
        matchedText: control.matchedText,
        sourceText: truncateSourceText(trimmed),
        source,
        matchType: null,
        intentPolarity: control.polarity,
        confidence: BRAND_CONFIDENCE.canonicalExact,
        ambiguous: false,
      });
    }
  }

  // 3. 逐子句实体匹配 + 子句内极性判定。
  const clauseMatches = splitClauses(trimmed).flatMap((clause) =>
    matchClause(clause, source, index),
  );

  // 歧义词形：同一词形对应多个品牌 → 单独产出 ambiguous 结果，不参与品牌去重。
  const uniqueMatches: Array<ClauseMatch & { brand: BrandCandidate }> = [];
  for (const match of clauseMatches) {
    const brands = distinctBrandsOf(match.entries);
    if (brands.length > 1) {
      results.push({
        canonicalName: null,
        brandId: null,
        matchedText: match.matchedText,
        sourceText: truncateSourceText(match.sourceText),
        source,
        matchType: match.matchType,
        intentPolarity: match.negated ? 'negative' : 'positive',
        confidence: BRAND_CONFIDENCE.ambiguous,
        ambiguous: true,
        candidates: brands.map((brand) => ({
          canonicalName: brand.brandName,
          brandId: brand.brandId,
        })),
      });
      continue;
    }
    uniqueMatches.push({
      ...match,
      brand: { canonicalName: brands[0].brandName, brandId: brands[0].brandId },
    });
  }

  // 品牌去重：同一品牌命中标准名与别名时只返回一个结果（取最高档位）；
  // 同一品牌同轮又要又不要时，显式否定优先（§6.3.1 规则 3）。
  const byBrand = new Map<string, { brand: BrandCandidate; match: ClauseMatch }>();
  for (const match of uniqueMatches) {
    const key = match.brand.canonicalName;
    const existing = byBrand.get(key);
    if (!existing) {
      byBrand.set(key, { brand: match.brand, match });
      continue;
    }
    const better =
      MATCH_TYPE_PRIORITY[match.matchType] < MATCH_TYPE_PRIORITY[existing.match.matchType];
    byBrand.set(key, {
      brand: match.brand,
      match: {
        ...(better ? match : existing.match),
        negated: existing.match.negated || match.negated,
      },
    });
  }

  const idMatchedBrands = new Set(
    idResolutions.map((r) => r.canonicalName).filter((name): name is string => Boolean(name)),
  );
  for (const { brand, match } of byBrand.values()) {
    if (idMatchedBrands.has(brand.canonicalName)) continue; // brand_id 档已覆盖（§7.2 只返回一条）
    results.push({
      canonicalName: brand.canonicalName,
      brandId: brand.brandId,
      matchedText: match.matchedText,
      sourceText: truncateSourceText(match.sourceText),
      source,
      matchType: match.matchType,
      intentPolarity: match.negated ? 'negative' : 'positive',
      confidence: CONFIDENCE_BY_MATCH_TYPE[match.matchType],
      ambiguous: false,
    });
  }

  // 4. 品类展开：命中品类词且未命中任何具体品牌时触发；昵称不做品类展开（§6.2）。
  const matchedSpecificBrand =
    idResolutions.length > 0 || uniqueMatches.length > 0 || results.some((r) => r.ambiguous);
  if (!matchedSpecificBrand && source !== 'contact_name') {
    const normalizedText = normalizeForBrandMatch(trimmed);
    for (const { category, matchedKeyword, matchedIndex } of matchCategories(
      normalizedText,
      index.categories,
    )) {
      // 品类词处于否定语境（"不要咖啡"）时不展开：确定性轨宁缺毋滥，交 LLM 轨处理。
      // 位置取自 matchCategories 命中的那次出现——不能重新 indexOf，否则"咖啡师…不要咖啡"
      // 这类文本会把否定判定锚到工种词那次出现上。
      if (isBrandSpanNegated(normalizedText, matchedIndex, matchedKeyword.length)) {
        continue;
      }
      // 品类命中一律展开为全部成员品牌（§6.2）——不设默认品牌，理由见
      // category-expansion.ts 的 BRAND_CATEGORIES 注释。
      for (const brandName of category.brands) {
        results.push({
          canonicalName: brandName,
          brandId: index.brandIdByName.get(brandName) ?? null,
          matchedText: category.label,
          sourceText: truncateSourceText(trimmed),
          source,
          matchType: 'category_expansion',
          intentPolarity: 'positive',
          confidence: BRAND_CONFIDENCE.categoryExpansion,
          ambiguous: false,
        });
      }
    }
  }

  return results;
}

/** 解析 "品牌ID：10239" 契约行；ID 必须在品牌库命中，查不到就不猜。 */
function resolveBrandIdMentions(
  text: string,
  source: BrandResolutionSource,
  index: BrandCatalogIndex,
): BrandResolution[] {
  const results: BrandResolution[] = [];
  const seen = new Set<number>();
  for (const match of text.matchAll(BRAND_ID_CONTRACT_REGEX)) {
    const brandId = Number(match[1]);
    if (!Number.isFinite(brandId) || seen.has(brandId)) continue;
    seen.add(brandId);
    if (index.nonEmployerBrandIds.has(brandId)) continue;
    const brand = index.byBrandId.get(brandId);
    if (!brand) continue;
    results.push({
      canonicalName: brand.name,
      brandId,
      matchedText: match[0],
      sourceText: truncateSourceText(text),
      source,
      matchType: 'brand_id',
      intentPolarity: 'positive',
      confidence: BRAND_CONFIDENCE.brandId,
      ambiguous: false,
    });
  }
  return results;
}

const SHORT_LATIN_NICKNAME_PATTERN = /^(?:你好|嗨)?(?:我是|我叫|叫我|昵称是)[a-z0-9]{2,3}$/;
const GEOGRAPHIC_SUFFIX_PATTERN =
  /^(?:大道|街道|地铁站|公交站|小区|开发区|路|街|巷|弄|胡同|镇|乡|村|区|县|市|苑|园|里|号)/;

/**
 * 裸自我介绍是加好友昵称验证语，不写品牌；2-3 位昵称还额外拦截 contact_name。
 * 带求职/地点上下文的 "ZARA导购"、"KFC松江" 仍按原规则识别。
 */
function isLowInformationShortLatinMatch(params: {
  normalizedClause: string;
  normalizedAlias: string;
  source: BrandResolutionSource;
}): boolean {
  if (params.source === 'contact_name') {
    return (
      /^[a-z0-9]{2,3}$/.test(params.normalizedAlias) &&
      params.normalizedClause === params.normalizedAlias
    );
  }
  if (params.source !== 'user_text') return false;
  if (isBareSelfIntroduction(params.normalizedClause, params.normalizedAlias)) return true;
  if (isLatinNicknameSelfIntroMatch(params.normalizedClause, params.normalizedAlias)) return true;
  if (!/^[a-z0-9]{2,3}$/.test(params.normalizedAlias)) return false;
  if (isGroupNicknameIntroduction(params.normalizedClause, params.normalizedAlias)) return true;
  return SHORT_LATIN_NICKNAME_PATTERN.test(params.normalizedClause);
}

const SELF_INTRO_PREFIX_PATTERN = /^(?:你好|哈喽|嗨)?(?:我是|我叫|叫我|昵称是)/;
/** 自介余部出现任一求职语境信号即不算昵称（"我是想问luckin还招吗"照常识别）。 */
const SELF_INTRO_JOB_HINT_PATTERN = /[想找要问招做干]|应聘|兼职|全职|工作|上班|岗位?/;

/**
 * 自介句里的英数昵称片段不是品牌。「我是🥚冠Bing」归一化剥掉 emoji 后是
 * "我是冠bing"，而 ≥4 字符英数别名（如 BIIIING缤水 的 "bing"）允许无边界子串包含，
 * 昵称自介必误命中（2026-07-21 生产审计）。既有 2-3 字符守卫覆盖不到这一档：
 * 自介前缀 + 余部呈昵称形态（短、含命中别名、无求职语境词）→ 判低信息放弃匹配。
 */
function isLatinNicknameSelfIntroMatch(normalizedClause: string, normalizedAlias: string): boolean {
  if (!/^[a-z0-9]{2,8}$/.test(normalizedAlias)) return false;
  const prefix = SELF_INTRO_PREFIX_PATTERN.exec(normalizedClause);
  if (!prefix) return false;
  const remainder = normalizedClause.slice(prefix[0].length);
  if (remainder.length === 0 || remainder.length > 12) return false;
  if (!remainder.includes(normalizedAlias)) return false;
  return !SELF_INTRO_JOB_HINT_PATTERN.test(remainder);
}

function isBareSelfIntroduction(normalizedClause: string, normalizedAlias: string): boolean {
  return [
    `我是${normalizedAlias}`,
    `我叫${normalizedAlias}`,
    `叫我${normalizedAlias}`,
    `昵称是${normalizedAlias}`,
    `im${normalizedAlias}`,
    `iam${normalizedAlias}`,
  ].includes(normalizedClause);
}

/**
 * 加群后的来源说明里，末尾 2-3 位英数串通常是群昵称，不是品牌：
 * “我是群聊「独立客&上海餐饮兼职12群」的LL”。
 */
function isGroupNicknameIntroduction(normalizedClause: string, normalizedAlias: string): boolean {
  return (
    /^(?:你好|嗨)?(?:我是|我叫)/.test(normalizedClause) &&
    /(?:群聊|群里|群内|兼职群)/.test(normalizedClause) &&
    normalizedClause.endsWith(normalizedAlias)
  );
}

// 刻意不含"周五"这类星期词：星期+数字（"周五711有班吗"）多是品牌问询而非时段。
const TEMPORAL_PREFIX_PATTERN = /(?:晚上|晚间|夜里|上午|下午|早上|凌晨|中午|傍晚|每天|每晚)$/;
const TEMPORAL_SUFFIX_PATTERN = /^(?:点半|点钟|点|小时|号|月|日|年)/;

/**
 * 时间语境中的数字片段不是品牌："晚上7-11点" 归一化塌缩成 "晚上711点" 后，
 * "711" 会经数字边界包含误命中 7-11便利店（2026-07-20 生产假阳性）。
 * 纯数字别名的命中片段紧邻时段前缀或时间单位后缀时不认；
 * 候选人真指门店的 "去711买东西" / 整句 "7-11" 不受影响。
 */
function isTemporalNumericMatch(
  normalizedClause: string,
  spanStart: number,
  normalizedAlias: string,
): boolean {
  if (spanStart < 0 || !/^[0-9]+$/.test(normalizedAlias)) return false;
  const before = normalizedClause.slice(0, spanStart);
  const after = normalizedClause.slice(spanStart + normalizedAlias.length);
  return TEMPORAL_PREFIX_PATTERN.test(before) || TEMPORAL_SUFFIX_PATTERN.test(after);
}

/** 地址中的同名片段不是品牌："鄂尔多斯路" 不得命中品牌 "鄂尔多斯1980"。 */
function isGeographicNameMatch(
  normalizedClause: string,
  spanStart: number,
  spanLength: number,
): boolean {
  if (spanStart < 0) return false;
  const suffix = normalizedClause.slice(spanStart + spanLength);
  return GEOGRAPHIC_SUFFIX_PATTERN.test(suffix);
}

/** 单子句内的实体匹配：全等 token（短别名）+ 长别名包含 + 短英数边界包含。 */
function matchClause(
  clause: string,
  source: BrandResolutionSource,
  index: BrandCatalogIndex,
): ClauseMatch[] {
  const normalizedClause = normalizeForBrandMatch(clause);
  if (!normalizedClause) return [];

  // 匹配 token：原子句 token ∪ 剥离极性控制词后的 token（让"不要全家"露出短别名本体）。
  const tokens = new Set(buildExactMatchTokens(clause));
  for (const token of buildExactMatchTokens(stripPolarityControlWords(normalizedClause))) {
    tokens.add(token);
  }

  const matches: ClauseMatch[] = [];
  const seenNormalized = new Set<string>();

  for (const candidate of index.candidates) {
    if (seenNormalized.has(candidate.normalized)) continue;

    let matched = false;
    let spanStart = -1;

    if (tokens.has(candidate.normalized)) {
      matched = true;
      spanStart = normalizedClause.indexOf(candidate.normalized);
    } else if (candidate.containEligible && normalizedClause.includes(candidate.normalized)) {
      matched = true;
      spanStart = normalizedClause.indexOf(candidate.normalized);
    } else if (candidate.shortLatinBoundaryEligible) {
      spanStart = findLatinBoundarySpan(normalizedClause, candidate.normalized);
      matched = spanStart >= 0;
    }

    if (!matched) continue;
    if (
      isLowInformationShortLatinMatch({
        normalizedClause,
        normalizedAlias: candidate.normalized,
        source,
      }) ||
      isGeographicNameMatch(normalizedClause, spanStart, candidate.normalized.length) ||
      isTemporalNumericMatch(normalizedClause, spanStart, candidate.normalized)
    ) {
      continue;
    }
    seenNormalized.add(candidate.normalized);

    const entries = index.byNormalized.get(candidate.normalized) ?? [candidate];
    const negated =
      spanStart >= 0 &&
      isBrandSpanNegated(normalizedClause, spanStart, candidate.normalized.length);
    // 档位按证据形态定（§6.2）：全等 token 才是 exact 档；包含/边界包含一律 containment 档，
    // 即使命中的是标准名（"肯德基还招吗" 里的 肯德基 是子串证据，不是完全相等证据）。
    matches.push({
      entries,
      matchType: tokens.has(candidate.normalized)
        ? candidate.isCanonical
          ? 'canonical_exact'
          : 'alias_exact'
        : 'alias_containment',
      matchedText: candidate.alias,
      sourceText: clause,
      negated,
    });
  }

  return matches;
}

/**
 * 短英数别名的 token 边界包含匹配：匹配片段前后不得是英数字符。
 * "kfc松江" 命中 "kfc"；"mcm" 不命中 "mc"。返回片段起点，未命中返回 -1。
 */
function findLatinBoundarySpan(normalizedText: string, alias: string): number {
  let fromIndex = 0;
  for (;;) {
    const start = normalizedText.indexOf(alias, fromIndex);
    if (start < 0) return -1;
    const before = start > 0 ? normalizedText[start - 1] : '';
    const after =
      start + alias.length < normalizedText.length ? normalizedText[start + alias.length] : '';
    const boundaryBefore = !before || !/[a-z0-9]/.test(before);
    const boundaryAfter = !after || !/[a-z0-9]/.test(after);
    if (boundaryBefore && boundaryAfter) return start;
    fromIndex = start + 1;
  }
}

// ==================== 工具入口别名标准化（§8.2 消费方复用） ====================

export interface ResolvedAliasBrand extends BrandCandidate {
  /** 是否经品类词展开而来（品类查询列表须先减去会话 excludedBrands，§6.2）。 */
  viaCategoryExpansion: boolean;
}

export interface AliasResolutionOutcome {
  /** 入口标准化后可执行的唯一标准品牌（含品类展开出的品牌集合）。 */
  applied: ResolvedAliasBrand[];
  rejected: Array<{
    input: string;
    reason: 'unmatched' | 'ambiguous' | 'low_confidence';
    candidates?: BrandCandidate[];
  }>;
}

/**
 * 把工具入参的品牌别名列表解析成唯一标准品牌（§8.2）。
 *
 * 入参是名称参数而非句子：跑同一套匹配管线但不做极性判定；
 * 品类词（"咖啡"）展开为品类品牌，保持已上线的品类召回不回归。
 */
export function resolveBrandAliasInputs(
  inputs: string[],
  catalog: BrandItem[],
): AliasResolutionOutcome {
  const applied = new Map<string, ResolvedAliasBrand>();
  const rejected: AliasResolutionOutcome['rejected'] = [];

  for (const rawInput of inputs) {
    const input = rawInput?.trim();
    if (!input) continue;

    const resolutions = resolveBrands(input, 'user_text', catalog);
    const ambiguous = resolutions.find((r) => r.ambiguous);
    const executable = resolutions.filter(
      (r) => !r.ambiguous && r.canonicalName && r.intentPolarity === 'positive',
    );

    if (executable.length > 0) {
      for (const resolution of executable) {
        const viaCategoryExpansion = resolution.matchType === 'category_expansion';
        const existing = applied.get(resolution.canonicalName!);
        applied.set(resolution.canonicalName!, {
          canonicalName: resolution.canonicalName!,
          brandId: resolution.brandId,
          // 同一品牌被显式点名与品类展开同时命中时，按显式命中处理（不减 excluded）
          viaCategoryExpansion: (existing?.viaCategoryExpansion ?? true) && viaCategoryExpansion,
        });
      }
      continue;
    }
    if (ambiguous) {
      rejected.push({ input, reason: 'ambiguous', candidates: ambiguous.candidates });
      continue;
    }
    rejected.push({ input, reason: 'unmatched' });
  }

  return { applied: Array.from(applied.values()), rejected };
}

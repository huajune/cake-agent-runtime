/**
 * duliday_job_list 品牌查询计划（§8.1 组合规则 + §8.2 入口标准化的工具侧消费层）。
 *
 * 职责：把「模型原始品牌参数 + brandFilterMode + 会话品牌状态」归一成一个可执行、
 * 可审计的查询计划。品牌识别/归一化本身全部委托 resolution/brand（单一居所），
 * 这里只做查询形态的组合决策：
 *
 * | 组合                                   | 生效查询                       | brandSource |
 * | 品牌列表非空（mode 未传或 enforce/exclude） | 按指定品牌查/排除              | model_input |
 * | 列表空 + mode 未传                      | 会话品牌兜底 currentBrand      | session_state / none |
 * | 列表空 + clear / browse_all             | 无品牌查询                     | none        |
 * | 列表空 + enforce / exclude              | 矛盾组合，报错                 | —           |
 */

import type { BrandItem } from '@/sponge/sponge.types';
import { resolveBrandAliasInputs } from '@resolution/brand/brand-matcher';
import type {
  BrandCandidate,
  BrandFilterMode,
  BrandSource,
  NormalizedBrandQueryMeta,
  SessionBrandRef,
  SessionBrandState,
} from '@resolution/brand/brand-resolution.types';

export interface BrandQueryPlan {
  /** 生效查询形态；无品牌查询按产生它的意图记 clear/browse_all（brandSource 区分归因）。 */
  filterMode: BrandFilterMode;
  brandSource: BrandSource;
  /** 实际应用的品牌条件（enforce=按此查询；exclude=按此排除）。 */
  applied: BrandCandidate[];
  rejected: NormalizedBrandQueryMeta['rejected'];
  /** 传给上游 API 的品牌条件（可得 ID 的品牌优先走 brandIdList，§8.2.3）。 */
  queryBrandIdList: number[];
  queryBrandAliasList: string[];
  /** exclude 模式的本地后过滤目标（上游接口无品牌排除参数，§8.1）。 */
  excludeBrands: BrandCandidate[];
  /** 模型传了品牌但全部被拒（未命中/歧义）：不得静默降级为无品牌查询。 */
  allRejected: boolean;
  /** 品类展开减去会话 excludedBrands 时被移除的品牌名（结果披露用，§6.2）。 */
  categoryExcludedRemoved: string[];
  /** 兜底/裁剪需向模型披露的说明（拼进工具结果）；null=无需披露。 */
  disclosure: string | null;
  /** 矛盾组合错误（列表空 + enforce/exclude）。 */
  error: 'empty_list_with_mode' | null;
}

function isSameBrand(a: { canonicalName: string; brandId: number | null }, b: SessionBrandRef) {
  if (a.brandId != null && b.brandId != null) return a.brandId === b.brandId;
  return a.canonicalName === b.canonicalName;
}

/** 组装 queryMeta.brand 小节（§11 类型化接口）。 */
export function toBrandQueryMeta(
  plan: BrandQueryPlan,
  fuzzySuggestions?: NormalizedBrandQueryMeta['fuzzySuggestions'],
): NormalizedBrandQueryMeta {
  return {
    filterMode: plan.filterMode,
    brandSource: plan.brandSource,
    appliedBrandIds: plan.applied
      .map((brand) => brand.brandId)
      .filter((id): id is number => id != null),
    appliedCanonicalNames: plan.applied.map((brand) => brand.canonicalName),
    rejected: plan.rejected,
    ...(fuzzySuggestions && fuzzySuggestions.length > 0 ? { fuzzySuggestions } : {}),
  };
}

export function buildBrandQueryPlan(input: {
  brandAliasList: string[];
  brandIdList: number[];
  brandFilterMode?: BrandFilterMode;
  sessionBrandState?: SessionBrandState | null;
  catalog: BrandItem[];
}): BrandQueryPlan {
  const { catalog } = input;
  const mode = input.brandFilterMode;

  const basePlan: BrandQueryPlan = {
    filterMode: 'clear',
    brandSource: 'none',
    applied: [],
    rejected: [],
    queryBrandIdList: [],
    queryBrandAliasList: [],
    excludeBrands: [],
    allRejected: false,
    categoryExcludedRemoved: [],
    disclosure: null,
    error: null,
  };

  // 入口标准化（§8.2）：别名 → 唯一标准品牌；冲突/未命中进 rejected。
  const aliasOutcome = resolveBrandAliasInputs(input.brandAliasList, catalog);
  basePlan.rejected = aliasOutcome.rejected;

  // 品类展开出的查询品牌列表须先减去会话 excludedBrands（§6.2）；显式点名的品牌不减
  // （显式正向表达优先级最高，且状态层的"反悔即赦免"会在收尾解除排斥）。
  const excludedRefs = input.sessionBrandState?.excludedBrands ?? [];
  const applied = aliasOutcome.applied.filter((brand) => {
    if (!brand.viaCategoryExpansion) return true;
    const excluded = excludedRefs.some((ref) => isSameBrand(brand, ref));
    if (excluded) basePlan.categoryExcludedRemoved.push(brand.canonicalName);
    return !excluded;
  });

  // 模型显式传的 brandIdList 原样采信（API 主键，目录可能缺 id，不做反向校验）；
  // 目录可回查到名称时补齐 canonicalName 供审计与本地等值过滤。
  const modelIds = Array.from(new Set(input.brandIdList.filter((id) => Number.isFinite(id))));
  const idBrands: BrandCandidate[] = modelIds.map((id) => ({
    canonicalName: catalog.find((brand) => brand.id === id)?.name ?? String(id),
    brandId: id,
  }));

  const inputProvided = input.brandAliasList.length > 0 || modelIds.length > 0;

  // 列表空 + clear / browse_all：无品牌查询（二者语义与审计归因不同）。
  if ((mode === 'clear' || mode === 'browse_all') && !inputProvided) {
    return { ...basePlan, filterMode: mode, brandSource: 'none' };
  }

  // 列表空 + enforce / exclude：矛盾组合。
  if ((mode === 'enforce' || mode === 'exclude') && !inputProvided) {
    return { ...basePlan, filterMode: mode, brandSource: 'none', error: 'empty_list_with_mode' };
  }

  if (inputProvided) {
    // 全部品牌入参被拒（未命中/歧义）：不形成品牌过滤，也绝不静默放行无品牌查询。
    if (applied.length === 0 && modelIds.length === 0) {
      return {
        ...basePlan,
        filterMode: mode === 'exclude' ? 'exclude' : 'enforce',
        brandSource: 'model_input',
        allRejected: true,
      };
    }

    const merged = dedupeBrands([...idBrands, ...applied]);
    if (mode === 'exclude') {
      return {
        ...basePlan,
        filterMode: 'exclude',
        brandSource: 'model_input',
        applied: merged,
        excludeBrands: merged,
      };
    }

    // enforce（列表非空时的默认语义；模型带品牌又传 clear/browse_all 属矛盾入参，
    // 显式品牌参数优先，按 enforce 处理）
    const idsFromApplied = applied
      .map((brand) => brand.brandId)
      .filter((id): id is number => id != null);
    return {
      ...basePlan,
      filterMode: 'enforce',
      brandSource: 'model_input',
      applied: merged,
      queryBrandIdList: Array.from(new Set([...modelIds, ...idsFromApplied])),
      // 可得 ID 时优先生成 brandIdList；没有 ID 才保留标准品牌名（§8.2.3/8.2.4）
      queryBrandAliasList: applied
        .filter((brand) => brand.brandId == null)
        .map((brand) => brand.canonicalName),
      disclosure:
        basePlan.categoryExcludedRemoved.length > 0
          ? `品类展开已按候选人此前排斥自动剔除：${basePlan.categoryExcludedRemoved.join('、')}（候选人重新点名可解除）`
          : null,
    };
  }

  // 列表空 + mode 未传：会话品牌兜底（§8.1，仅 currentBrand 一档——只补跨轮遗忘）。
  const currentBrand = input.sessionBrandState?.currentBrand ?? null;
  if (currentBrand) {
    return {
      ...basePlan,
      filterMode: 'enforce',
      brandSource: 'session_state',
      applied: [{ canonicalName: currentBrand.canonicalName, brandId: currentBrand.brandId }],
      queryBrandIdList: currentBrand.brandId != null ? [currentBrand.brandId] : [],
      queryBrandAliasList: currentBrand.brandId != null ? [] : [currentBrand.canonicalName],
      disclosure:
        `本次查询自动沿用候选人会话品牌「${currentBrand.canonicalName}」（brandSource=session_state）。` +
        `若这不符合本轮意图（如要放宽探索别家），请改传 brandFilterMode='clear' 重新查询。`,
    };
  }

  return { ...basePlan, filterMode: 'clear', brandSource: 'none' };
}

function dedupeBrands(brands: BrandCandidate[]): BrandCandidate[] {
  const seen = new Map<string, BrandCandidate>();
  for (const brand of brands) {
    const key = brand.brandId != null ? `id:${brand.brandId}` : `name:${brand.canonicalName}`;
    if (!seen.has(key)) seen.set(key, brand);
  }
  return Array.from(seen.values());
}

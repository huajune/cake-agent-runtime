/**
 * duliday_job_list 品牌查询计划（§6.1 组合规则 + §6.2 入口标准化的工具侧消费层）。
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
import { normalizeBrandNameForComparison } from '@resolution/brand/brand-normalize';
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
  /** 传给上游 API 的品牌条件（可得 ID 的品牌优先走 brandIdList，§6.2）。 */
  queryBrandIdList: number[];
  queryBrandAliasList: string[];
  /** exclude 模式的本地后过滤目标（上游接口无品牌排除参数，§6.1）。 */
  excludeBrands: BrandCandidate[];
  /** 模型传了品牌但全部被拒（未命中/歧义）：不得静默降级为无品牌查询。 */
  allRejected: boolean;
  /** 品类展开减去会话 excludedBrands 时被移除的品牌名（结果披露用，§3.2）。 */
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

/**
 * 只校验模型显式品牌是否曾被提及，不裁决意向、极性或历史状态。
 * null 表示提及集合不可用；目录无法确认的 ID/品牌不新增出处拦截。
 */
export function findUnmentionedQueryBrands(
  plan: BrandQueryPlan,
  mentionedBrands: ReadonlySet<string> | null | undefined,
  catalog: readonly BrandItem[],
): BrandCandidate[] {
  if (mentionedBrands == null || plan.brandSource !== 'model_input') return [];
  const knownNames = new Set(catalog.map((brand) => normalizeBrandNameForComparison(brand.name)));
  return plan.applied.filter((brand) => {
    if (brand.brandId != null && !catalog.some((item) => item.id === brand.brandId)) return false;
    const name = normalizeBrandNameForComparison(brand.canonicalName);
    return name.length > 0 && knownNames.has(name) && !mentionedBrands.has(name);
  });
}

/**
 * 被拒品牌是否**全部**为"品牌库里没有这个品牌"。
 *
 * unmatched 与 ambiguous/low_confidence 是两种事实：前者说明我们没有与该品牌合作
 * （话术要如实说没合作），后者说明品牌可能存在、只是指代不清（话术仍是澄清/无岗口径）。
 * 只要掺进一个非 unmatched 就不能按"没合作"对候选人下结论。unmatched_id 同样不算：
 * 目录外的数字 ID 多半是截图读数误差，而不是候选人点名了一个未合作品牌。
 */
export function allRejectedAsUnmatched(plan: BrandQueryPlan): boolean {
  return plan.rejected.length > 0 && plan.rejected.every((item) => item.reason === 'unmatched');
}

/** 被拒条目中目录外的品牌 ID（reason=unmatched_id）。 */
export function rejectedBrandIds(plan: BrandQueryPlan): string[] {
  return plan.rejected.filter((item) => item.reason === 'unmatched_id').map((item) => item.input);
}

export interface RejectedIdNeighbor {
  /** 被拒的目录外 ID 原文 */
  inputId: string;
  brandId: number;
  brandName: string;
  /** 与被拒 ID 的数字编辑关系：少读一位 / 多读一位 */
  relation: 'insert_one_digit' | 'delete_one_digit';
}

/**
 * 目录外品牌 ID 的数字近邻：只接受与被拒 ID 相差**单个字符插入或删除**的目录 ID
 * （截图视觉读数把 10006 读成 100006 这类多一位/少一位的误差）。
 * 替换类差异不纳入——10006 与 10008 是两个真实品牌，猜不得。
 */
export function findRejectedIdNeighbors(
  plan: BrandQueryPlan,
  catalog: readonly BrandItem[],
): RejectedIdNeighbor[] {
  const neighbors: RejectedIdNeighbor[] = [];
  for (const inputId of rejectedBrandIds(plan)) {
    for (const brand of catalog) {
      if (brand.id == null) continue;
      const candidate = String(brand.id);
      const relation = singleEditRelation(inputId, candidate);
      if (relation) neighbors.push({ inputId, brandId: brand.id, brandName: brand.name, relation });
    }
  }
  return neighbors;
}

function singleEditRelation(
  input: string,
  candidate: string,
): RejectedIdNeighbor['relation'] | null {
  if (input === candidate) return null;
  if (candidate.length === input.length - 1 && isSingleDeletion(input, candidate)) {
    return 'delete_one_digit';
  }
  if (candidate.length === input.length + 1 && isSingleDeletion(candidate, input)) {
    return 'insert_one_digit';
  }
  return null;
}

/** shorter 能否由 longer 删除恰好一个字符得到。 */
function isSingleDeletion(longer: string, shorter: string): boolean {
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < longer.length && j < shorter.length) {
    if (longer[i] === shorter[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    i += 1;
  }
  return true;
}

/**
 * 被拒品牌名中缺少候选人原话出处的条目。
 *
 * `findUnmentionedQueryBrands` 只核验**目录内**品牌（提及集合只登记目录可归一化的键），
 * 目录外品牌名（正是模型凭空编品牌的典型形态，生产 trace
 * batch_6acda349ce406a6aee8d6641_1791862156121 的「星巴克」）需要直接回到候选人原话
 * 做字面核对：候选人自己说过/截图里出现过的名字才允许进入「没合作」话术；
 * 没出处的名字视为模型臆造，由工具拒绝并要求清空品牌重查。
 *
 * - candidateTexts 为 null 表示出处材料不可用（无语料块），不新增拦截；
 * - 目录外 ID（unmatched_id）不走本核对：ID 来自截图读数，另有数字近邻处置。
 */
export function findUnprovenancedRejectedBrands(
  plan: BrandQueryPlan,
  candidateTexts: readonly string[] | null | undefined,
): BrandQueryPlan['rejected'] {
  if (candidateTexts == null || plan.brandSource !== 'model_input') return [];
  const haystack = candidateTexts.map((text) => normalizeBrandNameForComparison(text));
  return plan.rejected.filter((item) => {
    if (item.reason === 'unmatched_id') return false;
    const needle = normalizeBrandNameForComparison(item.input);
    if (!needle) return false;
    return !haystack.some((text) => text.includes(needle));
  });
}

/** 组装 queryMeta.brand 小节（§9 类型化接口）。 */
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

  // 入口标准化（§6.2）：别名 → 唯一标准品牌；冲突/未命中进 rejected。
  const aliasOutcome = resolveBrandAliasInputs(input.brandAliasList, catalog);
  basePlan.rejected = aliasOutcome.rejected;

  // 品类展开出的查询品牌列表须先减去会话 excludedBrands（§3.2）；显式点名的品牌不减
  // （显式正向表达优先级最高，且状态层的"反悔即赦免"会在收尾解除排斥）。
  const excludedRefs = input.sessionBrandState?.excludedBrands ?? [];
  const applied = aliasOutcome.applied.filter((brand) => {
    if (!brand.viaCategoryExpansion) return true;
    const excluded = excludedRefs.some((ref) => isSameBrand(brand, ref));
    if (excluded) basePlan.categoryExcludedRemoved.push(brand.canonicalName);
    return !excluded;
  });

  // 模型显式传的 brandIdList：目录带 ID 时按目录校验，目录外的 ID 进 rejected(unmatched_id)
  // 而不是用 String(id) 冒充品牌名去查、再把数字念给候选人（生产 trace
  // batch_6ad1eb74ce406a6aeec80597_1792142350490：视觉把 10006 读成 100006，候选人收到
  // 「100006在武进区这片暂时没找到」）。旧响应目录整体缺 id 时无从校验，保持原样采信。
  const rawModelIds = Array.from(new Set(input.brandIdList.filter((id) => Number.isFinite(id))));
  const catalogHasIds = catalog.some((brand) => brand.id != null);
  const modelIds = rawModelIds.filter((id) => {
    if (!catalogHasIds || catalog.some((brand) => brand.id === id)) return true;
    basePlan.rejected.push({ input: String(id), reason: 'unmatched_id' });
    return false;
  });
  const idBrands: BrandCandidate[] = modelIds.map((id) => ({
    canonicalName: catalog.find((brand) => brand.id === id)?.name ?? String(id),
    brandId: id,
  }));

  const inputProvided = input.brandAliasList.length > 0 || rawModelIds.length > 0;

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
      // 可得 ID 时优先生成 brandIdList；没有 ID 才保留标准品牌名（§6.2/8.2.4）
      queryBrandAliasList: applied
        .filter((brand) => brand.brandId == null)
        .map((brand) => brand.canonicalName),
      disclosure:
        basePlan.categoryExcludedRemoved.length > 0
          ? `品类展开已按候选人此前排斥自动剔除：${basePlan.categoryExcludedRemoved.join('、')}（候选人重新点名可解除）`
          : null,
    };
  }

  // 列表空 + mode 未传：会话品牌兜底（§6.1，仅 currentBrand 一档——只补跨轮遗忘）。
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

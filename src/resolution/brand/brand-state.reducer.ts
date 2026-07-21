/**
 * SessionBrandState 纯 reducer（§9.3）：(prevState, resolutions[]) → nextState。
 *
 * 状态迁移规则全部集中在此，memory 侧只负责「持锁读 brand_state → 调 reducer → 写回」。
 * 固定四步执行顺序自动保证（§9.3）：结果与说话顺序无关；同品牌又要又不要时排斥赢；
 * 图文并发时文字赢（图片先应用、文字后应用）。
 */

import {
  BRAND_EXECUTABLE_CONFIDENCE,
  type BrandResolution,
  type BrandResolutionSource,
  type PersistedBrandState,
  type SessionBrandRef,
  type SessionBrandState,
} from './brand-resolution.types';

export const EMPTY_BRAND_STATE: SessionBrandState = { currentBrand: null, excludedBrands: [] };

/** positive 的来源应用顺序：图片先、文字后（后应用者覆盖，故文字赢，§9.3 第 1 步）。 */
const POSITIVE_SOURCE_ORDER: BrandResolutionSource[] = ['image_description', 'user_text'];

export function isSameBrandRef(a: SessionBrandRef | null, b: SessionBrandRef | null): boolean {
  if (!a || !b) return a === b;
  if (a.brandId != null && b.brandId != null) return a.brandId === b.brandId;
  return a.canonicalName === b.canonicalName;
}

export function brandStateChanged(prev: SessionBrandState, next: SessionBrandState): boolean {
  if (!isSameBrandRef(prev.currentBrand, next.currentBrand)) return true;
  if (prev.excludedBrands.length !== next.excludedBrands.length) return true;
  return prev.excludedBrands.some(
    (brand, index) => !isSameBrandRef(brand, next.excludedBrands[index] ?? null),
  );
}

/**
 * 首次初始化（§9.4 懒迁移）：旧 preferences.brands 末位品牌 > 已验证昵称品牌 seed > 空。
 *
 * 旧数组末位是对话表达（时点晚于加好友的昵称），优先；其余旧品牌直接丢弃
 * （无极性无时序，不值得继承）。seed 仅在 brand_state 不存在时执行一次，
 * 状态一旦存在（哪怕被 browse_all 清成空值）永不重新 seed。
 */
export function initBrandState(input: {
  legacyLastBrand?: SessionBrandRef | null;
  nicknameSeed?: SessionBrandRef | null;
}): SessionBrandState {
  const currentBrand = input.legacyLastBrand ?? input.nicknameSeed ?? null;
  return { currentBrand, excludedBrands: [] };
}

/**
 * §9.3 四步 reducer。
 *
 * 第 0 步 过滤输入：剔除 contact_name 来源（昵称品牌只经首次初始化 seed 进入状态，
 *   否则这个每轮都在的静态值会不断把自己写回 currentBrand，覆盖对话演进）；
 *   剔除歧义与低于可执行阈值的结果。
 * 第 1 步 应用全部 positive（图片先、文字后）：
 *   - 显式命中和业务品类默认（matchType ≠ category_expansion）会解除该品牌的排斥；
 *     品类展开产出的 positive 不解除排斥（"咖啡"没有点名瑞幸，谈不上赦免）；
 *   - 同来源去重后恰 1 条且非品类展开 → 替换 currentBrand；咖啡默认 M Stand 属于单品牌默认；
 *     ≥2 条或含品类展开 → 多品牌
 *     表达，不立主品牌（候选人没说更想去哪个，系统不替他挑）。
 * 第 2 步 应用全部 negative：有品牌 → 加入 excludedBrands（恰是 currentBrand 则同时清空）；
 *   品牌为空（"换个品牌"/指示代词排斥）→ currentBrand 移入 excludedBrands 并清空。
 * 第 3 步 应用 browse_all：清空 currentBrand 和 excludedBrands。
 */
export function reduceBrandState(
  prev: SessionBrandState,
  resolutions: BrandResolution[],
): SessionBrandState {
  // 第 0 步：过滤输入
  const applicable = resolutions.filter((r) => r.source !== 'contact_name');

  const positives = applicable.filter(
    (r) =>
      r.intentPolarity === 'positive' &&
      !r.ambiguous &&
      r.canonicalName !== null &&
      r.confidence >= BRAND_EXECUTABLE_CONFIDENCE,
  );
  const negatives = applicable.filter((r) => r.intentPolarity === 'negative' && !r.ambiguous);
  const hasBrowseAll = applicable.some((r) => r.intentPolarity === 'browse_all');

  let currentBrand: SessionBrandRef | null = prev.currentBrand;
  let excludedBrands: SessionBrandRef[] = [...prev.excludedBrands];

  // §6.3.1 规则 3 的跨轨延伸：同一品牌同轮又要又不要（不同消息/不同轨各出一条，
  // resolveBrands 的单文本合并覆盖不到）时显式否定优先。净否定品牌不得参与第 1 步
  // 的 currentBrand 替换与排斥赦免——否则它会先上位把无辜的在位品牌顶下台、再被
  // 第 2 步排斥，最终在位者凭空出局（2026-07-21 审计："肯德基年龄不行"两次误清
  // 在位的成都你六姐/奥乐齐）。
  const negatedRefs = negatives.filter((r) => r.canonicalName !== null).map(toRef);
  const isNegatedThisTurn = (ref: SessionBrandRef) =>
    negatedRefs.some((negated) => isSameBrandRef(negated, ref));

  // 第 1 步：positive（图片先、文字后，逐来源各自应用）
  for (const source of POSITIVE_SOURCE_ORDER) {
    const group = dedupeByBrand(
      positives.filter((r) => r.source === source && !isNegatedThisTurn(toRef(r))),
    );
    if (group.length === 0) continue;

    for (const resolution of group) {
      if (resolution.matchType === 'category_expansion') continue;
      const ref = toRef(resolution);
      excludedBrands = excludedBrands.filter((brand) => !isSameBrandRef(brand, ref));
    }

    const isMultiBrand =
      group.length >= 2 || group.some((r) => r.matchType === 'category_expansion');
    if (!isMultiBrand) {
      currentBrand = toRef(group[0]);
    }
  }

  // 第 2 步：negative
  for (const resolution of negatives) {
    if (resolution.canonicalName !== null) {
      const ref = toRef(resolution);
      if (!excludedBrands.some((brand) => isSameBrandRef(brand, ref))) {
        excludedBrands.push(ref);
      }
      if (isSameBrandRef(currentBrand, ref)) currentBrand = null;
    } else if (currentBrand) {
      if (!excludedBrands.some((brand) => isSameBrandRef(brand, currentBrand))) {
        excludedBrands.push(currentBrand);
      }
      currentBrand = null;
    }
  }

  // 第 3 步：browse_all
  if (hasBrowseAll) {
    currentBrand = null;
    excludedBrands = [];
  }

  return { currentBrand, excludedBrands };
}

/**
 * 异步补写的「过期即弃」判定（§10.3 第二道防护）：
 * 补写结果的产生轮次早于 brand_state 最后变更时间 → 晚到旧信号只弃不写，不做时间倒流。
 */
export function shouldDropLateResolutions(
  state: PersistedBrandState,
  resolutionTurnMs: number,
): boolean {
  return state.updatedAtMs != null && resolutionTurnMs < state.updatedAtMs;
}

function toRef(resolution: BrandResolution): SessionBrandRef {
  return { canonicalName: resolution.canonicalName!, brandId: resolution.brandId };
}

/** 同来源内按品牌去重（规则轨与 LLM 轨可能对同一品牌各出一条，不能误判成多品牌表达）。 */
function dedupeByBrand(resolutions: BrandResolution[]): BrandResolution[] {
  const byBrand = new Map<string, BrandResolution>();
  for (const resolution of resolutions) {
    const key = resolution.canonicalName!;
    const existing = byBrand.get(key);
    // 保留档位更高（confidence 更高）的一条，品类展开档不覆盖显式命中档
    if (!existing || resolution.confidence > existing.confidence) {
      byBrand.set(key, resolution);
    }
  }
  return Array.from(byBrand.values());
}

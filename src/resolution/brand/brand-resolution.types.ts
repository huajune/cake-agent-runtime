/**
 * BrandResolution 全链路类型契约（docs/architecture/brand-resolution-refactor.md §6/§8/§9/§11）。
 *
 * 本文件只放类型与常量契约，不放实现逻辑：
 * - 解析结果（来源/匹配方式/极性/置信度/歧义）
 * - 会话品牌状态（currentBrand + excludedBrands 两字段）
 * - 工具查询形态（BrandFilterMode）与品牌来源（BrandSource）
 * - 工具查询元数据 queryMeta.brand（NormalizedBrandQueryMeta）
 */

/** 品牌解析的原始来源。会话记忆是结构化状态、模型工具参数不是用户事实来源，均不在此列。 */
export type BrandResolutionSource = 'user_text' | 'contact_name' | 'image_description';

/**
 * 匹配方式：记录「这条结果靠什么证据在品牌库命中」。
 * 分类轴是证据形态——证据形态决定误判时的修法（§6.2），修法不同的档位不合并。
 */
export type BrandMatchType =
  | 'brand_id'
  | 'canonical_exact'
  | 'alias_exact'
  | 'alias_containment'
  | 'category_expansion';

/**
 * 意图极性（3 值，§6.3）：默认 positive（提及即兴趣，业务裁定）；
 * "换个品牌"归入品牌为空的 negative；"品牌不限"为 browse_all。
 */
export type BrandIntentPolarity = 'positive' | 'negative' | 'browse_all';

export interface BrandCandidate {
  canonicalName: string;
  brandId: number | null;
}

export interface BrandResolution {
  canonicalName: string | null;
  brandId: number | null;

  /**
   * 命中的**品牌库词条**：别名或标准名本身；品类展开为品类标签，全局控制为控制词。
   * 注意它不是用户原文——用户原文在 sourceText（历史命名易误读，勿混用）。
   */
  matchedText: string | null;
  /**
   * 触发该命中的**用户原始输入片段**（子句级，超长截断至 SOURCE_TEXT_MAX_LENGTH）。
   *
   * 存在理由：误命中归因只靠 matchType + matchedText 判不了——「六姐」既可能是候选人
   * 打的真实简称，也可能是脏别名在无关语境里塌缩（2026-07-16「姐」P0 即此形态）。
   * 少了原文，每次日检都要回查 chat_messages 才能分真假阳性（2026-07-21 观测实测）。
   */
  sourceText: string | null;
  source: BrandResolutionSource;
  matchType: BrandMatchType | null;
  intentPolarity: BrandIntentPolarity;

  /** 规则评分，不代表统计概率（档位见 §7.4）。 */
  confidence: number;

  ambiguous: boolean;
  candidates?: BrandCandidate[];
}

/** §7.4 置信度档位。档位间不产生 (0.40, 0.75) 区间值，阈值即二分。 */
export const BRAND_CONFIDENCE = {
  brandId: 1.0,
  canonicalExact: 0.95,
  aliasExact: 0.9,
  aliasContainment: 0.75,
  categoryExpansion: 0.75,
  ambiguous: 0.4,
} as const;

/** 工具可执行阈值：≥ 0.75 的无歧义结果才可形成品牌过滤条件。 */
export const BRAND_EXECUTABLE_CONFIDENCE = 0.75;

/** sourceText 截断上限：够看清命中语境，又不至于把整段消息灌进事件表。 */
export const SOURCE_TEXT_MAX_LENGTH = 80;

/** 截断用户原文至 SOURCE_TEXT_MAX_LENGTH；空串归一为 null。 */
export function truncateSourceText(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length <= SOURCE_TEXT_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, SOURCE_TEXT_MAX_LENGTH)}…`;
}

// ==================== 会话品牌状态（§9） ====================

export interface SessionBrandRef {
  canonicalName: string;
  brandId: number | null;
}

/** 会话品牌状态：当前主品牌 + 排斥品牌（历史由 brand_state_change 事件流回放，不入状态）。 */
export interface SessionBrandState {
  currentBrand: SessionBrandRef | null;
  excludedBrands: SessionBrandRef[];
}

/**
 * Redis 落盘形态：SessionBrandState + 变更时间锚点。
 * updatedAtMs 服务异步补写（§10.3）的「过期即弃」判定——补写结果轮次早于最后变更时间即丢弃。
 */
export interface PersistedBrandState extends SessionBrandState {
  updatedAtMs?: number | null;
}

// ==================== 工具品牌控制（§8.1） ====================

/** duliday_job_list 入参（可选）；只描述查询形态，品牌来源单独记录在 BrandSource。 */
export type BrandFilterMode = 'enforce' | 'exclude' | 'clear' | 'browse_all';

/**
 * queryMeta 记录品牌来源（生产 brandAliasSource 的扶正）。
 * 昵称品牌不再是独立来源：它经 seed 进入 currentBrand（§6.3），查询侧统一表现为 session_state。
 */
export type BrandSource =
  | 'model_input' // 模型显式传入
  | 'session_state' // 会话品牌兜底：currentBrand（含昵称 seed 而来的首轮值）
  | 'none'; // 无品牌条件

// ==================== queryMeta.brand（§11） ====================

export interface NormalizedBrandQueryMeta {
  /** 生效查询形态（enforce/exclude/clear/browse_all） */
  filterMode: BrandFilterMode;
  /** 品牌来源：模型显式传入 / 会话品牌兜底 / 无品牌（审计区分"模型要的"与"兜底给的"） */
  brandSource: BrandSource;
  appliedBrandIds: number[];
  appliedCanonicalNames: string[];
  rejected: Array<{
    input: string;
    reason: 'unmatched' | 'ambiguous' | 'low_confidence';
    candidates?: BrandCandidate[];
  }>;
  /** 0 结果同音回指建议（既有 aliasFuzzyMatch 链路产出），见 §8.3 */
  fuzzySuggestions?: Array<{
    brandName: string;
    inputAlias: string;
    score: number;
  }>;
}

/**
 * 品牌名同音降权模糊匹配（0 结果同音回指）。
 *
 * 迁移自 tools/duliday/job-list/brand-fuzzy-match.util.ts（逻辑不变，只换居所，§8.3）。
 * 它与 resolve() 是并列的独立管线：候选集只有会话最近推荐过的品牌池、产出必须经候选人
 * 确认才作数、由"查询命中 0 结果"事件触发——不并入解析主链路。
 *
 * 解决 badcase batch_6a0c074c536c9654029b6930：
 *   - Agent 上一轮推荐了"成都你六姐"
 *   - 候选人回复"刘姐妹"（"六姐"→"刘姐"同音异调 + 脑补"姐妹"）
 *   - Agent 把"刘姐妹"当全新品牌调 duliday_job_list，brandAliasList 命中 0
 *   - 没做回指识别，直接照"无岗动作链"答"刘姐妹暂时没查到在招"
 *
 * 本工具在 brandAliasList 硬过滤后命中 0 时被调用：
 *   1. 把候选人输入的品牌别名和**会话最近推荐过的品牌池**做对比
 *   2. 拼音 syllable 重叠率 ≥ pinyinOverlapMin（默认 0.5）
 *   3. 同时共享汉字字数 ≥ 1（避免"刘建国"vs"奥乐齐"这种完全无关的同音误匹配）
 *   4. 命中即返回 `aliasFuzzyMatch`，让 Agent 反问"是不是想说 X？"而不是判 0
 *
 * 拼音匹配使用 pinyin-pro，无声调，对非中文字符（数字/英文）按字面保留。
 */

import { pinyin } from 'pinyin-pro';

/** 单条模糊匹配结果。 */
export interface BrandFuzzyMatch {
  /** 候选池中匹配上的品牌名 */
  brandName: string;
  /** 候选人原始输入（清洗前） */
  inputAlias: string;
  /** 共享的汉字（去重） */
  sharedChars: string[];
  /** 共享的拼音 syllable（去重） */
  sharedPinyin: string[];
  /** 拼音重叠率：sharedPinyin / min(inputSyllables, brandSyllables)，越高越像 */
  pinyinOverlapRatio: number;
  /** 综合得分，用于 ranking（0-1） */
  score: number;
}

interface MatcherOptions {
  /** 拼音重叠率最小阈值，低于此值不视为匹配。默认 0.5 */
  pinyinOverlapMin?: number;
  /** 共享汉字最少个数。默认 1 */
  sharedCharsMin?: number;
  /** 最多返回的匹配数。默认 3 */
  topK?: number;
}

const DEFAULT_OPTIONS: Required<MatcherOptions> = {
  pinyinOverlapMin: 0.5,
  sharedCharsMin: 1,
  topK: 3,
};

/**
 * 把中文字符串拆成 pinyin syllable 数组（无声调，小写）。
 *
 * - 非中文字符（数字/英文/符号）按字面保留为单 token
 * - 空字符串返回 `[]`
 */
function toPinyinTokens(text: string): string[] {
  if (!text) return [];
  // pinyin-pro：type: 'array' 返回每个字符的拼音；非中文字符返回原字符
  const tokens = pinyin(text, { toneType: 'none', type: 'array', nonZh: 'consecutive' });
  return tokens
    .map((token) => (typeof token === 'string' ? token.trim().toLowerCase() : ''))
    .filter(Boolean);
}

/**
 * 找出两个字符串共享的汉字（去重）。仅统计 CJK 字符，忽略数字/英文/符号。
 */
function findSharedChars(a: string, b: string): string[] {
  const setA = new Set<string>();
  for (const ch of a) {
    if (/[一-鿿]/.test(ch)) setA.add(ch);
  }
  const shared: string[] = [];
  const seen = new Set<string>();
  for (const ch of b) {
    if (setA.has(ch) && !seen.has(ch)) {
      shared.push(ch);
      seen.add(ch);
    }
  }
  return shared;
}

/**
 * 对单个 (input, brand) 对计算匹配得分。返回 null 表示不达阈值。
 */
function matchOne(
  input: string,
  brandName: string,
  options: Required<MatcherOptions>,
): BrandFuzzyMatch | null {
  const sharedChars = findSharedChars(input, brandName);
  if (sharedChars.length < options.sharedCharsMin) return null;

  const inputTokens = toPinyinTokens(input);
  const brandTokens = toPinyinTokens(brandName);
  if (inputTokens.length === 0 || brandTokens.length === 0) return null;

  const brandTokenSet = new Set(brandTokens);
  const sharedSet = new Set<string>();
  for (const token of inputTokens) {
    if (brandTokenSet.has(token)) sharedSet.add(token);
  }
  const sharedPinyin = Array.from(sharedSet);
  if (sharedPinyin.length === 0) return null;

  const denom = Math.min(inputTokens.length, brandTokens.length);
  const pinyinOverlapRatio = sharedPinyin.length / denom;
  if (pinyinOverlapRatio < options.pinyinOverlapMin) return null;

  // 综合得分：拼音重叠 70% + 汉字共享密度 30%
  // 汉字共享密度归一化到 inputChars 的 CJK 字符数
  const inputCjkCount = Array.from(input).filter((ch) => /[一-鿿]/.test(ch)).length;
  const charDensity = inputCjkCount > 0 ? sharedChars.length / inputCjkCount : 0;
  const score = Math.round((pinyinOverlapRatio * 0.7 + charDensity * 0.3) * 1000) / 1000;

  return {
    brandName,
    inputAlias: input,
    sharedChars,
    sharedPinyin,
    pinyinOverlapRatio: Math.round(pinyinOverlapRatio * 1000) / 1000,
    score,
  };
}

/**
 * 在候选品牌池里找出与候选人输入别名最接近的若干品牌。
 *
 * @param brandAliasList 候选人本轮 brandAliasList（通常来自 Agent 的工具调用参数）
 * @param brandPool 会话最近推荐过的品牌名集合（来自 sessionMemory.presentedJobs / lastCandidatePool）
 * @returns 按 score 降序排列的匹配；未达阈值返回空数组
 */
export function findBrandFuzzyMatches(
  brandAliasList: string[],
  brandPool: string[],
  options: MatcherOptions = {},
): BrandFuzzyMatch[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (!brandAliasList.length || !brandPool.length) return [];

  const uniqueAliases = Array.from(new Set(brandAliasList.map((s) => s?.trim()).filter(Boolean)));
  const uniqueBrands = Array.from(new Set(brandPool.map((s) => s?.trim()).filter(Boolean)));
  if (!uniqueAliases.length || !uniqueBrands.length) return [];

  const matches: BrandFuzzyMatch[] = [];
  for (const alias of uniqueAliases) {
    for (const brand of uniqueBrands) {
      // 跳过字面完全相等（已经是精确匹配，不属于"模糊匹配"语义）
      if (alias === brand) continue;
      const m = matchOne(alias, brand, opts);
      if (m) matches.push(m);
    }
  }

  // 去重：同一 brandName 保留得分最高的一条
  const bestByBrand = new Map<string, BrandFuzzyMatch>();
  for (const m of matches) {
    const prev = bestByBrand.get(m.brandName);
    if (!prev || m.score > prev.score) bestByBrand.set(m.brandName, m);
  }

  return Array.from(bestByBrand.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.topK);
}

/** 回指建议的分歧度判定阈值：top1 比 top2 高出该分差即视为高置信。 */
export const FUZZY_HIGH_CONFIDENCE_MARGIN = 0.15;

/**
 * 回指建议的置信档位（工具回复引导与守卫 brand_alias_fuzzy_match_ignored 共用同一判定）：
 * - 单一候选 / top1 领先 ≥ margin → high（直接沿用该品牌，轻确认带过）
 * - 多候选分数接近 → low（反问澄清）
 * - 无候选 → none
 */
export function resolveFuzzyConfidence(
  suggestions: ReadonlyArray<Pick<BrandFuzzyMatch, 'score'>>,
): 'high' | 'low' | 'none' {
  const top = suggestions[0];
  if (!top) return 'none';
  if (suggestions.length < 2) return 'high';
  return top.score - suggestions[1].score >= FUZZY_HIGH_CONFIDENCE_MARGIN ? 'high' : 'low';
}

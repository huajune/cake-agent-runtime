import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { normalizeForBrandMatch } from '@resolution/brand/brand-normalize';
import { resolveFuzzyConfidence } from '@resolution/brand/fuzzy-recall';

/**
 * 品牌名相关对账。
 *
 * 职责：
 * - 候选人/工具指定品牌时，回复不得结构化推荐其它品牌（requested_brand_mismatch）；
 * - 工具已高置信回指品牌别名/口误时，回复不得声称品牌没找到（brand_alias_fuzzy_match_ignored）。
 *
 * 数据源（§11 守卫切换点）：**只读 `toolResult.queryMeta.brand`**（工具入口标准化后的
 * 实际应用品牌），不再读模型原始 `brandAliasList`——对账对象从"模型请求的"修正为
 * "工具实际应用的"；被拒绝的昵称/模型别名（rejected）不构成对账依据。
 * 品牌归一化原语 import 自 resolution/brand（§5.1 单一居所），不再私有实现。
 *
 * 不负责：
 * - 不判断岗位是否真实存在（原 job-fact-hallucinations 规则族已于 2026-07-10 下线，
 *   接地治理交语义档）；
 * - 平台品牌错名（"独立日"）与岗位品牌改写（brand_name_violation）已于 2026-07-10
 *   用户裁定下线（勿修补勿重加）；工具层 duliday-job-list 输出仍走 sanitizeBrandName；
 * - 不检查门店名、地址、岗位名的其它字段，目前只聚焦品牌字段。
 *
 * 维护边界：
 * - 品牌提取刻意只覆盖结构化推荐标题，降低把普通口语里的品牌讨论误杀的概率；
 * - 如果新增一种岗位推荐模板，要同步补 extractStructuredJobTitleBrands 的解析模式。
 */
const BRAND_NO_MATCH_CLAIM_PATTERN =
  /(?:没找到|没有|暂无|暂时没有|查不到|未找到)[^。！？\n]{0,24}(?:这个|该)?(?:品牌|门店|岗位|在招)|(?:这个|该)?品牌[^。！？\n]{0,16}(?:没找到|没有|暂无|查不到|未找到)/;

export function detectRequestedBrandMismatch(text: string, toolCalls: AgentToolCall[] = []) {
  const appliedBrands = collectAppliedBrands(toolCalls);
  if (appliedBrands.size === 0) return null;
  if (isAskingBeforeAlternativeBrandRecommendation(text)) return null;

  const claimedBrands = extractStructuredJobTitleBrands(text);
  for (const claimed of claimedBrands) {
    if (isGroundedBrandClaim(claimed, appliedBrands)) continue;
    return {
      ruleId: 'requested_brand_mismatch',
      label: `工具实际应用品牌为"${[...appliedBrands].join('/')}"，但回复结构化推荐了其它品牌"${claimed}"`,
      action: GUARDRAIL_ACTION.REPLAN,
    };
  }

  return null;
}

export function detectBrandAliasFuzzyMatchIgnored(text: string, toolCalls: AgentToolCall[] = []) {
  if (!BRAND_NO_MATCH_CLAIM_PATTERN.test(text)) return null;

  const suggestion = readHighConfidenceFuzzySuggestion(toolCalls);
  if (!suggestion) return null;
  if (text.includes(suggestion) && !isNoMatchClaimAboutBrand(text, suggestion)) return null;

  return {
    ruleId: 'brand_alias_fuzzy_match_ignored',
    label: `duliday_job_list 返回高置信品牌回指"${suggestion}"，但回复仍声称品牌/岗位未找到`,
    action: GUARDRAIL_ACTION.REVISE,
  };
}

/** 读工具实际应用的品牌（enforce 生效条件；exclude 的排除目标不是"推荐来源"，不对账）。 */
function collectAppliedBrands(toolCalls: AgentToolCall[]): Set<string> {
  const brands = new Set<string>();
  const brandMeta = readLatestBrandQueryMeta(toolCalls);
  if (!brandMeta) return brands;
  if (brandMeta.filterMode !== 'enforce') return brands;
  for (const name of brandMeta.appliedCanonicalNames) {
    const cleaned = cleanClaimedBrandTitle(name);
    if (cleaned) brands.add(cleaned);
  }
  return brands;
}

function isAskingBeforeAlternativeBrandRecommendation(text: string): boolean {
  return /(?:没有|没找到|暂无|暂时没有)[^。！？\n]{0,24}(?:这个|该)?品牌[^。！？\n]{0,40}(?:其它|其他|别的|其他品牌|其它品牌)[^。！？\n]{0,20}(?:可以|接受|考虑|要不要|看看|行吗|可以吗)/.test(
    text,
  );
}

/**
 * 读 queryMeta.brand.fuzzySuggestions 的高置信回指（§8.3 守卫数据源切换）。
 * 这里必须读裸最后一次调用：回指建议恰恰长在 0 结果/错误返回上，换成"可用"口径会永远读不到。
 * 置信档位与工具共享 resolveFuzzyConfidence（分歧度阈值单一居所）。
 */
function readHighConfidenceFuzzySuggestion(toolCalls: AgentToolCall[]): string | null {
  const brandMeta = readLatestBrandQueryMeta(toolCalls);
  const suggestions = brandMeta?.fuzzySuggestions;
  if (!Array.isArray(suggestions) || suggestions.length === 0) return null;

  const scored = suggestions
    .map((item) => {
      const record = item as Record<string, unknown>;
      return {
        brandName: typeof record.brandName === 'string' ? record.brandName.trim() : '',
        score: typeof record.score === 'number' ? record.score : 0,
      };
    })
    .filter((item) => item.brandName.length > 0);
  if (scored.length === 0) return null;
  if (resolveFuzzyConfidence(scored) !== 'high') return null;
  return scored[0].brandName;
}

interface BrandQueryMetaView {
  filterMode: string;
  appliedCanonicalNames: string[];
  fuzzySuggestions?: unknown[];
}

/** 最后一次 duliday_job_list 调用的 queryMeta.brand 小节（成功/错误结果同一路径读取）。 */
function readLatestBrandQueryMeta(toolCalls: AgentToolCall[]): BrandQueryMetaView | null {
  const call = readLatestJobListCall(toolCalls);
  const result = call?.result;
  if (!result || typeof result !== 'object') return null;
  const queryMeta = (result as Record<string, unknown>).queryMeta;
  if (!queryMeta || typeof queryMeta !== 'object') return null;
  const brand = (queryMeta as Record<string, unknown>).brand;
  if (!brand || typeof brand !== 'object') return null;
  const brandRecord = brand as Record<string, unknown>;
  const appliedCanonicalNames = Array.isArray(brandRecord.appliedCanonicalNames)
    ? brandRecord.appliedCanonicalNames.filter((name): name is string => typeof name === 'string')
    : [];
  return {
    filterMode: typeof brandRecord.filterMode === 'string' ? brandRecord.filterMode : 'clear',
    appliedCanonicalNames,
    fuzzySuggestions: Array.isArray(brandRecord.fuzzySuggestions)
      ? brandRecord.fuzzySuggestions
      : undefined,
  };
}

function isNoMatchClaimAboutBrand(text: string, brandName: string): boolean {
  const escaped = escapeRegex(brandName);
  return new RegExp(
    `(?:${escaped})[^。！？\\n]{0,24}(?:没找到|没有|暂无|暂时没有|查不到|未找到)|(?:没找到|没有|暂无|暂时没有|查不到|未找到)[^。！？\\n]{0,24}(?:${escaped})`,
  ).test(text);
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从结构化岗位推荐标题提取“疑似品牌”。
 *
 * 目前覆盖两类常见格式：
 * - 品牌（门店/岗位补充） - 地址/岗位信息；
 * - 品牌 - 岗位 - 地址。
 *
 * 不从普通段落里提品牌，是为了避免“你可以考虑麦当劳吗”这类对话被误判。
 */
function extractStructuredJobTitleBrands(text: string): string[] {
  const brands = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\d+[.、]\s*)?([^：:\n，,（(\-—]{2,30})[（(][^）)\n]{1,40}[）)]\s*[-—]\s*[^。\n]{1,60}/g,
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\d+[.、]\s*)?([^：:\n，,（(\-—]{2,30})\s*[-—]\s*[^-\n—]{1,40}\s*[-—]\s*[^-\n—]{1,40}/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const brand = cleanClaimedBrandTitle(match[1]);
      if (brand) brands.add(brand);
    }
  }

  return [...brands];
}

/**
 * 清理编号、markdown 引用、项目符号后得到候选品牌名（展示形态，保留原文写法）。
 * 同时过滤“岗位/薪资/地址”等字段标题，避免把模板字段当品牌。
 * 对账比较不用此展示形态——一律走 brand-normalize 的归一化（见 isGroundedBrandClaim）。
 */
function cleanClaimedBrandTitle(value: string): string | null {
  const cleaned = value
    .replace(/^[\s#>*\-•\d.、]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  if (/^(品牌|岗位|门店|薪资|班次|要求|距离|地址)(?:$|[\s:：]|[是为])/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

/**
 * 品牌对账允许包含关系（归一化后比较，§5.1 归一化原语单一居所）：
 * - 工具应用“星巴克咖啡”，回复写“星巴克”可接受；
 * - 工具应用简称，回复标题包含完整品牌也可接受。
 */
function isGroundedBrandClaim(claimed: string, groundedBrands: Set<string>): boolean {
  const normalizedClaimed = normalizeForBrandMatch(claimed);
  if (!normalizedClaimed) return false;
  for (const grounded of groundedBrands) {
    const normalizedGrounded = normalizeForBrandMatch(grounded);
    if (!normalizedGrounded) continue;
    if (normalizedClaimed === normalizedGrounded) return true;
    if (
      normalizedClaimed.includes(normalizedGrounded) ||
      normalizedGrounded.includes(normalizedClaimed)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 最后一次 duliday_job_list 调用（不问可用与否）：只用于读 queryMeta.brand 等
 * **错误侧**信号——这些信号恰恰长在空/错结果上，换成"可用"口径会读不到。
 * 原 job-list-call.util 共享原语；2026-07-10 该 util 随 job-fact 规则族下线后内联至此。
 */
function readLatestJobListCall(toolCalls: AgentToolCall[]): AgentToolCall | null {
  return [...toolCalls].reverse().find((call) => call.toolName === 'duliday_job_list') ?? null;
}

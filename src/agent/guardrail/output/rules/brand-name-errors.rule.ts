import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';

/**
 * 品牌名相关对账。
 *
 * 职责：
 * - 候选人/工具入参指定品牌时，回复不得结构化推荐其它品牌（requested_brand_mismatch）；
 * - 工具已高置信回指品牌别名/口误时，回复不得声称品牌没找到（brand_alias_fuzzy_match_ignored）。
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
  const requestedBrands = collectRequestedBrandAliases(toolCalls);
  if (requestedBrands.size === 0) return null;
  if (isAskingBeforeAlternativeBrandRecommendation(text)) return null;

  const claimedBrands = extractStructuredJobTitleBrands(text);
  for (const claimed of claimedBrands) {
    if (isGroundedBrandClaim(claimed, requestedBrands)) continue;
    return {
      ruleId: 'requested_brand_mismatch',
      label: `候选人指定品牌为"${[...requestedBrands].join('/')}"，但回复结构化推荐了其它品牌"${claimed}"`,
      action: GUARDRAIL_ACTION.REPLAN,
    };
  }

  return null;
}

export function detectBrandAliasFuzzyMatchIgnored(text: string, toolCalls: AgentToolCall[] = []) {
  if (!BRAND_NO_MATCH_CLAIM_PATTERN.test(text)) return null;

  const suggestion = readHighConfidenceBrandAliasSuggestion(toolCalls);
  if (!suggestion) return null;
  if (text.includes(suggestion) && !isNoMatchClaimAboutBrand(text, suggestion)) return null;

  return {
    ruleId: 'brand_alias_fuzzy_match_ignored',
    label: `duliday_job_list 返回高置信品牌回指"${suggestion}"，但回复仍声称品牌/岗位未找到`,
    action: GUARDRAIL_ACTION.REVISE,
  };
}

function collectRequestedBrandAliases(toolCalls: AgentToolCall[]): Set<string> {
  const brands = new Set<string>();
  const latestJobListCall = readLatestJobListCall(toolCalls);
  const args = latestJobListCall?.args;
  if (!args || typeof args !== 'object') return brands;
  const brandAliasList = (args as Record<string, unknown>).brandAliasList;
  if (!Array.isArray(brandAliasList)) return brands;
  for (const alias of brandAliasList) {
    const normalized = normalizeClaimedBrand(String(alias));
    if (normalized) brands.add(normalized);
  }
  return brands;
}

function isAskingBeforeAlternativeBrandRecommendation(text: string): boolean {
  return /(?:没有|没找到|暂无|暂时没有)[^。！？\n]{0,24}(?:这个|该)?品牌[^。！？\n]{0,40}(?:其它|其他|别的|其他品牌|其它品牌)[^。！？\n]{0,20}(?:可以|接受|考虑|要不要|看看|行吗|可以吗)/.test(
    text,
  );
}

function readHighConfidenceBrandAliasSuggestion(toolCalls: AgentToolCall[]): string | null {
  // 这里必须读裸最后一次调用：aliasFuzzyMatch 恰恰长在 0 结果/错误返回的 details 上，
  // 换成"可用"口径会永远读不到高置信品牌回指。
  const call = readLatestJobListCall(toolCalls);
  const result = call?.result;
  if (!result || typeof result !== 'object') return null;
  const aliasFuzzyMatch = (result as Record<string, unknown>).aliasFuzzyMatch;
  if (!aliasFuzzyMatch || typeof aliasFuzzyMatch !== 'object') return null;
  const match = aliasFuzzyMatch as Record<string, unknown>;
  if (match.confidence !== 'high') return null;
  const suggestions = match.suggestions;
  if (!Array.isArray(suggestions) || suggestions.length === 0) return null;
  const first = suggestions[0];
  if (!first || typeof first !== 'object') return null;
  const brandName = (first as Record<string, unknown>).brandName;
  return typeof brandName === 'string' && brandName.trim() ? brandName.trim() : null;
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
      const brand = normalizeClaimedBrand(match[1]);
      if (brand) brands.add(brand);
    }
  }

  return [...brands];
}

/**
 * 清理编号、markdown 引用、项目符号后得到候选品牌名。
 * 同时过滤“岗位/薪资/地址”等字段标题，避免把模板字段当品牌。
 */
function normalizeClaimedBrand(value: string): string | null {
  const normalized = normalizeBrand(value.replace(/^[\s#>*\-•\d.、]+/, ''));
  if (!normalized) return null;
  if (/^(品牌|岗位|门店|薪资|班次|要求|距离|地址)(?:$|[\s:：]|[是为])/.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeBrand(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * 品牌对账允许包含关系：
 * - 工具返回“星巴克咖啡”，回复写“星巴克”可接受；
 * - 工具返回简称，回复标题包含完整品牌也可接受。
 */
function isGroundedBrandClaim(claimed: string, groundedBrands: Set<string>): boolean {
  for (const grounded of groundedBrands) {
    if (claimed === grounded) return true;
    if (claimed.includes(grounded) || grounded.includes(claimed)) return true;
  }
  return false;
}

/**
 * 最后一次 duliday_job_list 调用（不问可用与否）：只用于读 aliasFuzzyMatch / args 等
 * **错误侧**信号——这些信号恰恰长在空/错结果上，换成"可用"口径会读不到。
 * 原 job-list-call.util 共享原语；2026-07-10 该 util 随 job-fact 规则族下线后内联至此。
 */
function readLatestJobListCall(toolCalls: AgentToolCall[]): AgentToolCall | null {
  return [...toolCalls].reverse().find((call) => call.toolName === 'duliday_job_list') ?? null;
}

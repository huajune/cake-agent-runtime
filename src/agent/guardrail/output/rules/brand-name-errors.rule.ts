import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { sanitizeBrandName } from '@tools/utils/sanitize-brand-name.util';
import { readLatestJobListCall, readLatestUsableJobListCall } from './job-list-call.util';

/**
 * 品牌名错误：
 * - 平台/公司对外品牌必须说"独立客"，不能说历史名/错名"独立日"；
 * - 岗位品牌名必须来自本轮岗位工具接地结果，不能把 A 品牌岗位改写成 B 品牌岗位。
 *
 * 职责：
 * - 管对外品牌名错误，以及岗位推荐卡片里的品牌名被模型改写；
 * - 平台品牌错误不需要工具信号，只要 sanitizeBrandName 能修正，就说明 reply 里出现了禁用名称；
 * - 岗位品牌错误需要对账最后一次 duliday_job_list 返回的 brandName，确保“推荐标题”没有凭空换品牌。
 *
 * 不负责：
 * - 不判断岗位是否真实存在，那属于 job-fact-hallucinations；
 * - 不检查门店名、地址、岗位名的其它字段，目前只聚焦品牌字段。
 *
 * 维护边界：
 * - 岗位品牌名检查刻意只覆盖结构化推荐标题，降低把普通口语里的品牌讨论误杀的概率；
 * - 如果新增一种岗位推荐模板，要同步补 extractStructuredJobTitleBrands 的解析模式。
 */
const BRAND_NO_MATCH_CLAIM_PATTERN =
  /(?:没找到|没有|暂无|暂时没有|查不到|未找到)[^。！？\n]{0,24}(?:这个|该)?(?:品牌|门店|岗位|在招)|(?:这个|该)?品牌[^。！？\n]{0,16}(?:没找到|没有|暂无|查不到|未找到)/;

export function detectBrandNameError(text: string, toolCalls: AgentToolCall[] = []) {
  // 平台/公司品牌名先做全量扫描：这是独立于岗位工具的对外口径红线。
  if (sanitizeBrandName(text) !== text) {
    return {
      ruleId: 'brand_name_violation',
      label: '回复出现对外品牌名错误（如"独立日"；正确对外名称是"独立客"），禁止发出',
      action: GUARDRAIL_ACTION.BLOCK,
      blocked: true,
    };
  }

  // 岗位品牌名需要工具接地；没有 job_list 品牌结果时不做臆测。
  return detectJobBrandMismatch(text, toolCalls);
}

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

/**
 * 检查结构化岗位标题里的品牌是否来自本轮工具结果。
 * 例：工具返回“星巴克”，回复标题却写成“瑞幸咖啡 - 店员 - 近地铁”，应拦截。
 */
function detectJobBrandMismatch(text: string, toolCalls: AgentToolCall[]) {
  const groundedBrands = collectGroundedJobBrands(toolCalls);
  if (groundedBrands.size === 0) return null;

  const claimedBrands = extractStructuredJobTitleBrands(text);
  for (const claimed of claimedBrands) {
    if (isGroundedBrandClaim(claimed, groundedBrands)) continue;
    return {
      ruleId: 'brand_name_violation',
      label: `回复里的岗位品牌名"${claimed}"不在本轮岗位工具返回品牌中，禁止把岗位品牌改写后发出`,
      action: GUARDRAIL_ACTION.BLOCK,
      blocked: true,
    };
  }

  return null;
}

/**
 * 收集最后一次**可用**岗位工具结果里的品牌名。
 * 只从 duliday_job_list 读，避免其它工具里的自由文本污染品牌白名单。
 *
 * 必须取"最后一次可用"而不是裸最后一次（2026-07-06 review）：动作链"扩面查（有结果）
 * → 复核查（空/错）"下，裸最后一次读到的是错误结果——错误 details 里的
 * aliasFuzzyMatch.suggestions[].brandName 会被当成接地品牌，把上一次真实接地的推荐
 * 误判成品牌改写直接 block。
 */
function collectGroundedJobBrands(toolCalls: AgentToolCall[]): Set<string> {
  const brands = new Set<string>();
  const latestJobListCall = readLatestUsableJobListCall(toolCalls);
  if (latestJobListCall) collectBrandNames(latestJobListCall.result, brands);
  return brands;
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
 * 兼容 job-list 返回结构的多层包裹。
 * 历史结果可能在 result、rawData.result、basicInfo.brandName 等位置，因此递归浅层读取。
 */
function collectBrandNames(value: unknown, brands: Set<string>, depth = 0): void {
  if (depth > 5 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectBrandNames(item, brands, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  const directBrand = readNonEmptyString(record.brandName);
  if (directBrand) brands.add(normalizeBrand(directBrand));

  const basicInfo = record.basicInfo;
  if (basicInfo && typeof basicInfo === 'object') {
    const basicBrand = readNonEmptyString((basicInfo as Record<string, unknown>).brandName);
    if (basicBrand) brands.add(normalizeBrand(basicBrand));
  }

  collectBrandNames(record.result, brands, depth + 1);
  collectBrandNames(record.rawData, brands, depth + 1);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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

import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { asRecord, type RuleContradiction } from '../output-rule.types';

/**
 * 位置判断口径错误规则。
 *
 * 职责：
 * - 管 geocode 没有解析出唯一可信坐标时，reply 却已经基于位置做“附近有/无岗位、推荐门店、确认位置”的问题；
 * - 这类错误会让候选人误以为系统真的知道 TA 的位置，后续推荐也可能完全偏离城市/区县。
 *
 * 不负责：
 * - 不判断岗位列表里是否漏报距离，那属于 job-fact-hallucinations；
 * - 不做地理编码本身的纠错，只根据 geocode 结构化结果决定 reply 能不能下位置结论。
 *
 * 维护边界：
 * - 如果 reply 是在追问城市/具体地址，应豁免；
 * - 如果新增 geocode errorType 代表“不唯一/不可用”，要同步加入 uncertain 判断。
 */

const LOCATION_DECISION_CLAIM_PATTERN =
  /(?:附近|周边|离你|这个位置|你的位置|你这边|这附近)[^。！？\n]{0,30}(?:门店|岗位|有岗|暂无|没有|无岗|推荐|查到|查了)|(?:已|已经|帮你|给你)[^。！？\n]{0,18}(?:确认|定位|查到)[^。！？\n]{0,12}(?:位置|附近|门店|岗位)/;
const LOCATION_CLARIFICATION_PATTERN =
  /(?:哪个|哪座|所在|具体)[^。！？\n]{0,8}城市|城市[^。！？\n]{0,8}(?:确认|是哪里|是哪)|具体[^。！？\n]{0,8}(?:地址|位置|地标)|(?:上海|北京|广州|深圳|杭州|南京|苏州|成都|武汉|重庆|天津|长沙|西安|郑州|合肥|宁波|无锡)[^。！？\n]{0,8}(?:还是|或)/;
const GENERIC_CITY_CLARIFICATION_PATTERN =
  /(?:哪个|哪座|所在|具体)[^。！？\n]{0,8}城市|城市[^。！？\n]{0,8}(?:确认|是哪里|是哪)/;

export function detectGeocodeUncertainLocationClaim(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  // 先确认 reply 是否已经在“下位置结论”；如果只是闲聊或问地址，不进入工具对账。
  if (!LOCATION_DECISION_CLAIM_PATTERN.test(text)) return null;
  // “请确认城市/具体地址”是正确补问，不应因包含“位置/城市”而误伤。
  if (LOCATION_CLARIFICATION_PATTERN.test(text)) return null;

  // 取最后一次 geocode，避免同一轮多地址解析时拿到旧错误。
  const geocodeCall = [...toolCalls]
    .reverse()
    .find((call) => call.toolName === 'geocode' && call.result);
  const result = asRecord(geocodeCall?.result);
  if (!result) return null;

  const resolution = typeof result.resolution === 'string' ? result.resolution : null;
  const errorType = typeof result.errorType === 'string' ? result.errorType : null;
  // 这些结果都表示没有唯一可信坐标，不能继续做附近岗位判断。
  const uncertain =
    resolution === 'ambiguous' ||
    errorType === 'geocode.ambiguous_suffix' ||
    errorType === 'geocode.district_city_mismatch' ||
    errorType === 'geocode.unresolved_address';
  if (!uncertain) return null;

  return {
    ruleId: 'geocode_uncertain_location_claim',
    label: `geocode 未拿到唯一可用坐标（${errorType ?? `resolution=${resolution}`}），但回复已经基于位置做附近推荐/无岗判断/位置确认，需改写为确认城市或更具体地址`,
    action: GUARDRAIL_ACTION.REVISE,
  };
}

export function detectGeocodeAmbiguousCandidatesOmitted(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  if (!GENERIC_CITY_CLARIFICATION_PATTERN.test(text)) return null;

  const geocodeCall = [...toolCalls]
    .reverse()
    .find((call) => call.toolName === 'geocode' && call.result);
  const result = asRecord(geocodeCall?.result);
  if (!result || result.resolution !== 'ambiguous') return null;

  const cities = readCandidateCities(result.candidates);
  if (cities.length < 2) return null;

  const mentionedCount = cities.filter((city) => text.includes(city.replace(/市$/, ''))).length;
  if (mentionedCount >= 2) return null;

  return {
    ruleId: 'geocode_ambiguous_candidates_omitted',
    label: `geocode 返回多城市候选（${cities.join('/')}），但回复只泛泛追问城市，未列出候选项`,
    action: GUARDRAIL_ACTION.REVISE,
  };
}

function readCandidateCities(candidates: unknown): string[] {
  if (!Array.isArray(candidates)) return [];
  const cities = new Set<string>();
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    const city = typeof record?.city === 'string' ? record.city.trim() : '';
    if (city) cities.add(city);
  }
  return [...cities];
}

const PRECISE_DISTANCE_CLAIM_PATTERN = /\d+(?:\.\d+)?\s*(?:公里|千米|km)|离你最近/i;
// 已在追问更具体位置，或已声明距离是按区域估算 → 正确行为，豁免
const SPECIFIC_LOCATION_REQUEST_PATTERN =
  /发个?(?:精准)?定位|具体(?:位置|地址|在哪|哪条路|路段|地标)|哪个(?:商圈|地铁站|路口|街道|镇)|(?:附近|旁边)(?:有什么|的)(?:地标|商圈|地铁)|按[^。！？\n]{0,8}(?:中心|区)估算|大概估算/;

/**
 * 区级粗定位 + 精确距离声称检测（badcase recvjyv0SKiqe3 回归实测发现）。
 *
 * 候选人只报区名（"松江"）时 geocode 也能 unique 命中（行政区代表点），
 * 此时基于锚点算的门店距离与候选人真实位置可能差好几公里，
 * 回复不应把"2.2km"这类精确距离直接说给候选人，而应先追问具体位置/商圈/定位，
 * 或明确说明距离是按区域估算。
 */
export function detectDistrictLevelDistanceClaim(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  if (!PRECISE_DISTANCE_CLAIM_PATTERN.test(text)) return null;
  if (SPECIFIC_LOCATION_REQUEST_PATTERN.test(text)) return null;

  const geocodeCall = [...toolCalls]
    .reverse()
    .find((call) => call.toolName === 'geocode' && call.result);
  const result = asRecord(geocodeCall?.result);
  if (!result || result.resolution !== 'unique') return null;
  const inner = asRecord(result.result);
  if (inner?.areaLevelQuery !== true) return null;

  return {
    ruleId: 'district_level_distance_claim',
    label:
      '候选人只提供了区/市级位置（geocode areaLevelQuery=true，锚点为行政区代表点），但回复直接输出精确距离；应先追问具体位置/商圈/定位，或声明距离为区域估算',
    action: GUARDRAIL_ACTION.REVISE,
  };
}

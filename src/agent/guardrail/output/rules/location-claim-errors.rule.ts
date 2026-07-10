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
    errorType === 'geocode.anchor_mismatch' ||
    errorType === 'geocode.unresolved_address';
  if (!uncertain) return null;

  return {
    ruleId: 'geocode_uncertain_location_claim',
    label: `geocode 未拿到唯一可用坐标（${errorType ?? `resolution=${resolution}`}），但回复已经基于位置做附近推荐/无岗判断/位置确认，需改写为确认城市或更具体地址`,
    action: GUARDRAIL_ACTION.REVISE,
  };
}

// district_level_distance_claim（区级粗定位精确距离）已于 2026-07-10 下线：3 天 109 次
// 命中是全规则最大噪音源，大量正常的距离播报被强制重写。用户裁定整条下线。

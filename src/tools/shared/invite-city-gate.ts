import { normalizeCity } from '@biz/group-task/utils/city-normalize.util';
import { inferCitiesFromDistrictMentions } from '@tools/shared/district-city-map';

/**
 * invite_to_group 城市 provenance gate（tool guardrail，纯函数）。
 *
 * 根因（badcase recvk28F1xrsKj 图片识别后把候选人拉进杭州兼职群）：
 * invite 的 city 入参完全信模型自报——与 booking 曾经信 `prechecked` 是同一个
 * "模型自证"模式。拉群是不可逆副作用，city 必须能追溯到外生出处：
 * ① 会话记忆里的高置信城市事实（确定性抽取写入），或
 * ② 候选人本会话原文里出现过该城市（含定位消息渲染文本）。
 * 模型参数单独不构成依据（HC-2 权威字段准入的同一原则）。
 *
 * 2026-07-20 放宽（badcase：候选人说"顺义区马坡镇"/"浦东川沙"仍被反问城市）：
 * 字面匹配漏掉了区级地名 → 城市的确定性推断，新增出处
 * ③ 候选人原文出现全国无歧义的区级地名，且其所属城市与入参一致
 *   （district_inference，静态映射见 district-city-map.ts）。
 * 这是临时方案；geocode 结果穿线等完整出处链路待地址识别全链路改造统一落地。
 *
 * 判定只读、不产生副作用；拒绝均为可恢复（reject_collect 语义）：
 * - city_conflict：会话记忆有城市且与入参不一致 → 模型应改用 expectedCity 或先与候选人确认；
 * - city_unverified：任何出处都找不到该城市 → 模型应先向候选人确认所在城市。
 *
 * 已知边界（catalog residualRisk 同步登记）：
 * - 候选人原文提到他人城市/曾居城市时仍会放行（出处判定不是意图判定，区名档同）；
 * - 跨会话回访客户城市只在长期画像里、本会话未提及时会被要求重新确认城市。
 */

export type InviteCityGateVerdict =
  | { decision: 'allow'; matchedBy: 'session_fact' | 'user_text' | 'district_inference' }
  | {
      decision: 'reject';
      reason: 'city_conflict' | 'city_unverified';
      /** city_conflict 时给出会话记忆里的城市，供模型直接改用。 */
      expectedCity?: string;
    };

export interface InviteCityGateInput {
  /** 模型传入的 city 参数。 */
  requestedCity: string;
  /** 会话记忆中的高置信城市事实；无或低置信时传 null。 */
  sessionCity: string | null;
  /** 本会话候选人侧原文（user role 文本）。 */
  userTexts: readonly string[];
}

export function evaluateInviteCityGate(input: InviteCityGateInput): InviteCityGateVerdict {
  const requested = normalizeCity(input.requestedCity);
  const session = normalizeCity(input.sessionCity);

  if (session && session === requested) {
    return { decision: 'allow', matchedBy: 'session_fact' };
  }

  // 城市名至少 2 字才做文本包含判定，避免单字误命中
  if (requested.length >= 2) {
    const mentioned = input.userTexts.some((text) => text.includes(requested));
    if (mentioned) {
      return { decision: 'allow', matchedBy: 'user_text' };
    }
  }

  // 区级地名确定性推断：候选人报了无歧义区名（如"顺义区马坡镇"→北京），
  // 视同报了所属城市。与 user_text 同级，优先于 session 冲突判定
  //（候选人本轮报的区代表当前位置，允许覆盖旧会话事实）。
  if (inferCitiesFromDistrictMentions(input.userTexts).has(requested)) {
    return { decision: 'allow', matchedBy: 'district_inference' };
  }

  if (session) {
    return { decision: 'reject', reason: 'city_conflict', expectedCity: session };
  }
  return { decision: 'reject', reason: 'city_unverified' };
}

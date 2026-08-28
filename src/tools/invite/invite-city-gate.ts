import { normalizeCityName as normalizeCity } from '@resolution/geo';
import { scanGeoSignalsFromText } from '@resolution/geo';
import type { FinalizedVisualFactSheet } from '@resolution/signal/visual';
import { mapLocationCityCandidates } from '@resolution/turn-hints/admission';

/**
 * invite_to_group 城市 provenance gate（tool guardrail，纯函数）。
 *
 * 拉群是不可逆副作用，city 不能由模型自证，必须能追溯到外生出处：
 * ① 会话记忆里的高置信城市事实（确定性抽取写入），或
 * ② 候选人本会话原文里出现过该城市（含定位消息渲染文本），或
 * ③ 候选人原文命中 @resolution/geo 地名白名单（区名唯一映射 / 高置信地标），
 *   且推导城市与入参一致（district_inference），或
 * ④ 本轮 geocode unique 解析确权过该城市（turn_geocode）。
 * 模型参数单独不构成依据（HC-2 权威字段准入的同一原则）。
 *
 * 判定只读、不产生副作用；拒绝均为可恢复（reject_collect 语义）：
 * - city_conflict：会话记忆有城市且与入参不一致 → 模型应改用 expectedCity 或先与候选人确认；
 * - city_unverified：任何出处都找不到该城市 → 模型应先向候选人确认所在城市。
 *
 * 已知边界（catalog residualRisk 同步登记）：
 * - 候选人原文提到他人城市/曾居城市时仍会放行（出处判定不是意图判定，区名/地标档同）；
 * - 跨会话回访客户城市只在长期画像里、本会话未提及时会被要求重新确认城市。
 */

export type InviteCityGateVerdict =
  | {
      decision: 'allow';
      matchedBy:
        | 'session_fact'
        | 'user_text'
        | 'district_inference'
        | 'turn_geocode'
        | 'turn_map_screenshot';
    }
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
  /** prep 时刻一次性扫描出的区名/地标城市集合。 */
  geoSignalCities: ReadonlySet<string>;
  /**
   * 本轮 geocode unique 解析确权的城市（context.ledger.geo.anchors）。
   *
   * 城市确权在回合收尾才写档、下轮才进 sessionCity；geocode → job_list → invite
   * 可能发生在同一轮，因此闸门还要直接消费本轮刚确权的
   * 城市。这里把轮内锚点作为第四档出处直接消费——与 save_attested_city 同一
   * 证据源（amap 解析，外生非模型自报），只是消费时机提前到轮内。
   */
  turnResolvedCities?: readonly (string | null | undefined)[];
  /**
   * 本轮视觉事实 sheet（context.ledger.visual.factSheets，visual-fact-structuring R3）。
   * map_location 截图的城市字段是候选人位置证据，作第五档出处；job_posting 的
   * 门店城市不算，因为它不表示候选人所在地。
   */
  turnVisualSheets?: ReadonlyArray<{ messageId: string; sheet: FinalizedVisualFactSheet }>;
}

export function evaluateInviteCityGate(input: InviteCityGateInput): InviteCityGateVerdict {
  const requested = normalizeCity(input.requestedCity);
  const session = normalizeCity(input.sessionCity);

  // normalizeCityName 对空/纯后缀输入返回 null：不判空则下方
  // `requested.length` NPE，被外层 catch 误分类成 INVITE_API_FAILED 且 replyInstruction
  // 错路由。city 入参解析不出即无出处，走 city_unverified 收集语义。
  if (!requested) {
    return { decision: 'reject', reason: 'city_unverified' };
  }

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

  // 地名白名单确定性推断：候选人报了唯一区名（"顺义区马坡镇"→北京）或高置信
  // 地标（"陆家嘴"→上海），视同报了所属城市。与 user_text 同级，优先于 session
  // 冲突判定（候选人本轮报的区代表当前位置，允许覆盖旧会话事实）。
  if (input.geoSignalCities.has(requested)) {
    return { decision: 'allow', matchedBy: 'district_inference' };
  }

  // 本轮 geocode 确权档：同样优先于 session 冲突判定——本轮解析基于候选人
  // 本轮位置线索（geocode 自身有 anchor gate 防错解析），代表当前位置；
  // 会话档案的冲突不覆盖规则仍由 saveToolAttestedCity 在收尾时把关。
  const turnResolved = (input.turnResolvedCities ?? [])
    .map((city) => normalizeCity(city ?? null))
    .filter(Boolean);
  if (turnResolved.includes(requested)) {
    return { decision: 'allow', matchedBy: 'turn_geocode' };
  }

  // 本轮地图截图档（visual-fact-structuring R3）：map_location
  // sheet 的城市字段是候选人用来指自己位置的证据，经 geo 白名单归一后作第五档
  // 出处。job_posting / 聊天截图的城市不进本档（那是门店/他人的位置）。
  const sheetCities = new Set<string>();
  for (const entry of input.turnVisualSheets ?? []) {
    for (const candidate of mapLocationCityCandidates(entry.sheet)) {
      const scan = scanGeoSignalsFromText(candidate);
      const city = scan.city?.value ? normalizeCity(scan.city.value) : null;
      if (city) sheetCities.add(city);
    }
  }
  if (sheetCities.has(requested)) {
    return { decision: 'allow', matchedBy: 'turn_map_screenshot' };
  }

  if (session) {
    return { decision: 'reject', reason: 'city_conflict', expectedCity: session };
  }
  return { decision: 'reject', reason: 'city_unverified' };
}

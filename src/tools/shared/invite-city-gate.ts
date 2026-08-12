import { normalizeCityName as normalizeCity } from '@resolution/geo';
import { scanGeoSignalsFromText } from '@resolution/geo';
import type { FinalizedVisualFactSheet } from '@resolution/signal/visual';
import { mapLocationCityCandidates } from '@resolution/evidence/admission';

/**
 * invite_to_group 城市 provenance gate（tool guardrail，纯函数）。
 *
 * 根因（badcase recvk28F1xrsKj 图片识别后把候选人拉进杭州兼职群）：
 * invite 的 city 入参完全信模型自报——与 booking 曾经信 `prechecked` 是同一个
 * "模型自证"模式。拉群是不可逆副作用，city 必须能追溯到外生出处：
 * ① 会话记忆里的高置信城市事实（确定性抽取写入），或
 * ② 候选人本会话原文里出现过该城市（含定位消息渲染文本），或
 * ③ 候选人原文命中 @resolution/geo 地名白名单（区名唯一映射 / 高置信地标），
 *   且推导城市与入参一致（district_inference），或
 * ④ 本轮 geocode unique 解析确权过该城市（turn_geocode，#765 补"轮末写档、
 *   下轮才进 session_fact"的同轮时序空档）。
 * 模型参数单独不构成依据（HC-2 权威字段准入的同一原则）。
 *
 * 演进史：
 * - 2026-07-20 放宽（badcase：候选人说"顺义区马坡镇"/"浦东川沙"仍被反问城市）：
 *   字面匹配漏掉区级地名 → 城市的确定性推断，新增 district_inference 档
 *   （静态映射曾落 tools 层私表 district-city-map.ts）。
 * - 2026-07-27 证据化穿线（badcase 6a671722 沈阳 / 6a618a6e 上海浦东 GPS 连拒 3 次）：
 *   geocode unique 确权与定位分享逆解析现已按 source='system' 写入 sessionFacts.pref.city
 *   （memory-lifecycle save_attested_city / extractFacts 定位注入），跨轮场景由
 *   session_fact 档（①）命中——工具确权是外生证据，不属于"模型自证"。
 * - 2026-07-28 #765：turn_geocode 档补同轮时序空档（④）。
 * - 2026-07-28 收编：district-city-map.ts 私表删除——与 @resolution/geo 的
 *   UNIQUE_SUBDIVISION_TO_CITY 双轨维护、每补一个区名只修一半（拉群门认、查询路径不认，
 *   青岛批次即被迫双写两表）。③ 现统一走 geo 白名单扫描；朝阳/通州等业务偏置
 *   条目随统一对齐提取层口径（同一句话提取层本就写 city 高置信事实，gate 下一轮
 *   凭 ① 放行——此前的"更严"只在同轮内生效，跨轮不成立，属幻觉严格性）。
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
   * 本轮 geocode unique 解析确权的城市（context.ledger.geocodeAnchors）。
   *
   * 同轮时序空档（v10.31.0 发版后残留 2 例实证，chat 6a680c63"高明万悦天地"/
   * 6a66d0f8"莘庄"）：城市确权走回合收尾写档、下轮才进 sessionCity，而
   * geocode → job_list 无岗 → invite 常发生在同一轮，闸门看不到本轮刚确权的
   * 城市。这里把轮内锚点作为第四档出处直接消费——与 save_attested_city 同一
   * 证据源（amap 解析，外生非模型自报），只是消费时机提前到轮内。
   */
  turnResolvedCities?: readonly (string | null | undefined)[];
  /**
   * 本轮视觉事实 sheet（context.ledger.visualFactSheets，visual-fact-structuring R3）。
   * map_location 截图的城市字段是候选人位置证据，作第五档出处；job_posting 的
   * 门店城市不算（badcase x3pdj7qh：截图门店城市被当候选人城市拉错群）。
   */
  turnVisualSheets?: ReadonlyArray<{ messageId: string; sheet: FinalizedVisualFactSheet }>;
}

export function evaluateInviteCityGate(input: InviteCityGateInput): InviteCityGateVerdict {
  const requested = normalizeCity(input.requestedCity);
  const session = normalizeCity(input.sessionCity);

  // normalizeCityName 对空/纯后缀输入返回 null（PR #1000 评审 P2-1）：不判空则下方
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

  // 本轮地图截图档（visual-fact-structuring R3，badcase oaz6inzf）：map_location
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

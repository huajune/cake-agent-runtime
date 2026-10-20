import { normalizeCityName as normalizeCity } from '@resolution/geo';
import { mentionsPlaceNameStandalone, scanGeoSignalsFromText } from '@resolution/geo';
import { isAssistantQuestionConfirmedInDialogue } from '@resolution/notary/dialogue-confirmation';
import { extractDialogueTurns } from '@resolution/signal/dialogue';
import type { FinalizedVisualFactSheet } from '@resolution/signal/visual';
import { mapLocationCityCandidates } from '@resolution/turn-hints/admission';
import type { ToolBuildContext } from '@shared-types/tool.types';

/**
 * invite_to_group 城市 provenance gate（tool guardrail，纯函数）。
 *
 * 拉群是不可逆副作用，city 不能由模型自证，必须能追溯到外生出处：
 * ① 会话记忆里的高置信城市事实（确定性抽取写入），或
 * ② 候选人本会话原文里出现过该城市（含定位消息渲染文本），或
 * ③ 候选人原文命中 @resolution/geo 地名白名单（区名唯一映射 / 高置信地标），
 *   且推导城市与入参一致（district_inference），或
 * ④ 本轮 geocode unique 解析确权过该城市（turn_geocode），或
 * ⑤ 本轮地图截图的城市字段（turn_map_screenshot），或
 * ⑥ 候选人当前已在该城市的兼职群（实时核验结果，realtime_group），或
 * ⑦ 候选人在途预约工单的门店在该城市（booking_store），或
 * ⑧ 招募经理问过「你是在 X 对吧」且候选人下一条是肯定应答（confirmed_question，
 *   复用 @resolution/notary 的问答绑定公证）。
 * 模型参数单独不构成依据（HC-2 权威字段准入的同一原则）。
 *
 * ⑥–⑧ 三档于 2026-10-19 加入（BadCase 复核 [17]：候选人在佛山群、模型传 city=佛山 被静默丢弃，
 * 全国搜「王府井」唯一命中北京并写入 pref.city=北京）；它们都排在 session 冲突判定之前——
 * 群成员关系/在途预约/候选人亲口确认都是比旧会话事实更贴近当前位置的外生证据。
 *
 * 判定只读、不产生副作用；拒绝均为可恢复（reject_collect 语义）：
 * - city_conflict：会话记忆有城市且与入参不一致 → 模型应改用 expectedCity 或先与候选人确认；
 * - city_unverified：任何出处都找不到该城市 → 模型应先向候选人确认所在城市。
 *
 * 已知边界（catalog residualRisk 同步登记）：
 * - 候选人原文提到他人城市/曾居城市时仍会放行（出处判定不是意图判定，区名/地标档同）；
 * - 跨会话回访客户城市只在长期画像里、本会话未提及时会被要求重新确认城市；
 * - 在途预约门店城市只在本轮加载了预约地址详情时可用（面试/地址相关回合），不是每轮都有。
 */

export type InviteCityGateVerdict =
  | {
      decision: 'allow';
      matchedBy:
        | 'session_fact'
        | 'user_text'
        | 'district_inference'
        | 'turn_geocode'
        | 'turn_map_screenshot'
        | 'realtime_group'
        | 'booking_store'
        | 'confirmed_question';
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
  /**
   * 候选人当前已在的兼职群城市（与 prompt [候选人当前所在兼职群] 同源的实时核验结果，
   * 核验失败为空）。群成员关系是候选人所在城市的强外生证据。
   */
  realtimeGroupCities?: readonly string[];
  /**
   * 候选人在途预约工单的门店城市（与 [当前预约信息] 同门可见的工单；只在本轮加载了
   * 预约地址详情时有值），排除已明确不属于候选人本人的工单。
   */
  bookingStoreCities?: readonly string[];
  /**
   * 本会话对话消息（user/assistant 原始 transport messages），用于识别「招募经理问
   * 你是在 X 对吧 → 候选人肯定应答」的确认链。
   */
  dialogueMessages?: readonly unknown[];
}

/** 工具上下文里⑥–⑧ 三档出处的统一取数，geocode 与 invite 两个消费方共用一份口径。 */
export function collectCityGateContextInputs(
  context: ToolBuildContext,
): Pick<InviteCityGateInput, 'realtimeGroupCities' | 'bookingStoreCities' | 'dialogueMessages'> {
  return {
    realtimeGroupCities: context.archive.realtimeGroupCities ?? [],
    bookingStoreCities: (context.archive.bookingWorkOrders ?? [])
      // 非本人快照仅供展示；指针路径未显式标记归属，由 active_booking 保证。
      .filter((workOrder) => workOrder.ownedByCandidate !== false)
      .map((workOrder) => workOrder.storeCity ?? null)
      .filter((city): city is string => Boolean(city && city.trim())),
    dialogueMessages: context.turnInput.messages,
  };
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

  // 城市名至少 2 字才做文本包含判定，避免单字误命中；「上海村」「上海路」里的城市字样
  // 是村名/路名的一部分，不算候选人提到了该城市。
  if (requested.length >= 2) {
    const mentioned = input.userTexts.some((text) => mentionsPlaceNameStandalone(text, requested));
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

  // 已在群档：候选人已经在该城市的兼职群里（实时核验，非记忆），群成员关系即城市证据。
  if (normalizeCitySet(input.realtimeGroupCities).has(requested)) {
    return { decision: 'allow', matchedBy: 'realtime_group' };
  }

  // 在途预约门店档：候选人已约面的门店在该城市。
  if (normalizeCitySet(input.bookingStoreCities).has(requested)) {
    return { decision: 'allow', matchedBy: 'booking_store' };
  }

  // 问答确认档：招募经理问「你是在 X 对吧」且候选人下一条为肯定短答。
  if (
    input.dialogueMessages?.length &&
    isCityConfirmedByCandidate(requested, input.dialogueMessages)
  ) {
    return { decision: 'allow', matchedBy: 'confirmed_question' };
  }

  if (session) {
    return { decision: 'reject', reason: 'city_conflict', expectedCity: session };
  }
  return { decision: 'reject', reason: 'city_unverified' };
}

function normalizeCitySet(cities: readonly string[] | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const city of cities ?? []) {
    const value = normalizeCity(city);
    if (value) normalized.add(value);
  }
  return normalized;
}

/** 句级切分：只拿含城市名、且带求证语气的那一句当问句，避免整条消息里别处的「吗/？」误配。 */
const SENTENCE_SPLIT_RE = /[。！？!?\n；;]+/u;
// 只公证“你（现在）在 X（这边）吗/对吧”这一封闭问句形态；
// 岗位意向、工作经历等含城市的其他问题不能据肯定短答推成当前位置。
const CITY_LOCATION_PREFIX_RE = /(?:你|您)(?:现在|目前)?(?:是)?在\s*$/u;
const CITY_LOCATION_SUFFIX_RE =
  /^(?:市)?(?:这边|这里|这儿|附近)?\s*(?:对吧|对吗|对么|对不对|是吗|是么|是吧|吗|么|吧)$/u;

function extractCityConfirmationQuestion(assistantText: string, city: string): string | null {
  for (const raw of assistantText.split(SENTENCE_SPLIT_RE)) {
    const sentence = raw.trim();
    if (!sentence || !mentionsPlaceNameStandalone(sentence, city)) continue;
    const cityIndex = sentence.indexOf(city);
    if (
      CITY_LOCATION_PREFIX_RE.test(sentence.slice(0, cityIndex)) &&
      CITY_LOCATION_SUFFIX_RE.test(sentence.slice(cityIndex + city.length))
    )
      return sentence;
  }
  return null;
}

/**
 * 候选人最近一次城市证据是否仍支持「你是在 X 对吧」的肯定应答。
 *
 * 问句与应答的相邻绑定、肯定词表判定都交给 @resolution/notary 的
 * isAssistantQuestionConfirmedInDialogue；只传入当前问答对，避免重复问句绑定到旧答案。
 * 后来的城市陈述或另一轮城市问答会覆盖旧确认，不能让旧确认穿透 session 冲突闸。
 */
function isCityConfirmedByCandidate(city: string, messages: readonly unknown[]): boolean {
  const turns = extractDialogueTurns(messages);
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const answer = turns[index];
    if (answer.role !== 'user') continue;
    const statedCity = normalizeCity(scanGeoSignalsFromText(answer.text).city?.value ?? null);
    if (statedCity && statedCity !== city) return false;

    const previous = turns[index - 1];
    if (previous?.role !== 'assistant') continue;
    const questionCity = normalizeCity(scanGeoSignalsFromText(previous.text).city?.value ?? null);
    if (!questionCity) continue;
    const question = extractCityConfirmationQuestion(previous.text, questionCity);
    if (!question) continue;
    return (
      questionCity === city &&
      isAssistantQuestionConfirmedInDialogue(question, answer.text, [
        { role: 'assistant', content: previous.text },
        { role: 'user', content: answer.text },
      ])
    );
  }
  return false;
}

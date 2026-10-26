// business-rules: GEO-01, GEO-03, GEO-04
/**
 * 地理编码工具 — 将地名文本解析为标准化地址 + 经纬度
 *
 * 调用契约：city 不再强制必填，工具自己做歧义判定。
 * - 命中"通用后缀黑名单"（万达广场 / 购物中心 / 裸通名车站 …）且未传 city → 报错让 Agent 反问
 * - 否则放给 `searchCandidates`，按返回的城市分布三态收敛：
 *     - 1 个城市 → resolution=unique（与旧返回 shape 兼容）
 *     - 多个城市 → resolution=ambiguous（Agent 按候选清单反问）
 *     - 0 条 → GEOCODE_UNRESOLVED_ADDRESS（无法识别该地名）
 */

import { toErrorMessage } from '@infra/utils/error.util';
import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import type { GeocodeCandidate } from '@infra/geocoding/geocoding.types';
import {
  candidateAdministrativeAreaEchoedInAddress,
  candidateDistrictMatchesAddress,
  extractDistrictStems,
  groupCandidatesByCity,
  pickAnchorCandidate,
} from '@infra/geocoding/geocoding-candidate-ranker.util';
import {
  hasGenericAmbiguousSuffix,
  isRecognizedCityName,
  normalizeCityName,
  normalizeDistrictForLookup,
} from '@resolution/geo';
import type { ToolBuildContext, ToolBuilder } from '@shared-types/tool.types';
import type { GeocodeLocationAnchor } from '@shared-types/turn.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import {
  collectCityGateContextInputs,
  evaluateInviteCityGate,
  type InviteCityGateVerdict,
} from '@tools/invite/invite-city-gate';
import { extractDialogueTurns, extractUserTexts } from '@resolution/signal/dialogue';
import { selectEvidenceDialogueMessages } from '@resolution/signal/corpus';
import { extractCandidateTextsFromCorpus } from '@resolution/signal/self-report';
import { HUMAN_AGENT_MESSAGE_MARKER } from '@shared-types/corpus.types';
import { evaluateGeocodeAddressProvenance } from '@tools/geocode/address-provenance.util';

const logger = new Logger('geocode');

/** Agent 看到的 ambiguous 候选条目（裁剪掉冗余字段，留下足够反问的信息）。 */
interface AmbiguousCandidateView {
  city: string;
  district: string;
  formattedAddress: string;
  poiName: string;
}

const DESCRIPTION = `将地名或地址解析为标准化的省/市/区/镇层级和经纬度坐标。

## 何时调用
- 候选人提到商圈/地标/街道/详细地址等自由位置线索，且你准备做具体岗位/门店推荐时
- 附近推荐、距离比较、范围筛选只是最明显的触发场景，不是唯一场景
- 只要候选人给了可用位置线索，且你准备做具体岗位/门店推荐，本工具就是主链路的前置步骤

## 何时不调用
- 只按区域/品牌/岗位做普通查岗时，不要为了 geocode 额外补问城市
- 行政区域的规范全称可直接查岗，不必经过 geocode
- 当前上下文已足够确定城市时，不要对明显属于该城市的区域再做常识性反问
- 候选人本轮的 [位置分享] 已自带经纬度时，直接使用即可，不必再 geocode 一次

## 作用
1. 补全行政区划：将模糊地名解析为完整的省/市/区/街道，用返回的 district 作为 duliday_job_list.regionNameList
2. 获取经纬度：用返回的 latitude/longitude 组装 duliday_job_list.location；需要按指定范围筛选时，将范围换算成米写入 location.range

## 参数
- address 必传；当你判断该地点是地铁站时，保留站名后的车站或地铁站后缀，不要只传裸路名，以免坐标被定位到整条道路的远端
- city 可选；按以下优先级判断要不要填：
  1. 候选人当前明示城市 / [本轮查询硬约束] 的城市 / [本轮解析线索] 的城市 / [会话记忆] 任一存在 → 直接填入（哪怕本工具的 address 是商圈/地标，也要带上这个已知城市）
  2. 上面都没有，但候选人已在的兼职群、在途预约门店或候选人对城市问句的肯定应答有城市出处 → 填入对应城市
  3. 没有上述出处 → city 留空（不传或传 null），由工具判定；不要凭通识或推测填城市
- 不要为了 city 反复反问候选人——拿不准就留空让工具自己处理
- city 只认有出处的城市：候选人亲口说过 / 会话记忆 / 候选人已在的兼职群城市 / 在途预约门店城市 / 候选人对「你是在 X 对吧」的肯定应答 / 本轮解析确权。凭通识或推测填入、找不到出处的 city 会被工具忽略并在结果里标注 \`_cityIgnored\`——此时本次是全国搜索，**不得向候选人说"已确认城市"**

## 通用后缀黑名单（命中即跨城同名，不允许凭通识填 city）
万达广场 / 万象城 / 吾悦广场 / 银泰 / 天街 / 印象城 / 大悦城 /
购物中心 / 商场 / 广场 / 步行街 / 美食街 /
大学 / 学院 / 医院 / 人民公园 / 人民广场 / 中心医院 /
裸通名的交通枢纽（"火车站""汽车站""长途汽车站"这类没有专名前缀的）

**带专名前缀的车站不算黑名单**：有具体站名的车站，
有上述城市出处就填 city，没有出处就留空，
工具会全国搜索；真撞名时返回 ambiguous 候选清单再反问。

命中黑名单且没有城市出处时 **city 必须留空**——工具会报 \`${TOOL_ERROR_TYPES.GEOCODE_AMBIGUOUS_SUFFIX}\`，按 \`_replyInstruction\` 中性反问候选人所在城市，反问禁止带具体城市名。

## 返回三态
- \`resolution=unique\` + 扁平 \`result\`：单城唯一命中，直接把 result 当结果用，组装 location 走 duliday_job_list
  - **解析成功即城市已确认**：结果第一个字段 \`_cityConfirmed\` 已写明"已确认城市：XX"。**此后禁止再向候选人询问已确认的城市**，也禁止宣称该位置未找到——应直接按已确认城市与坐标查岗。仅当结果带 \`_cityConflictNotice\`（本次解析城市与会话记忆城市冲突）时，按其指引向候选人做一句确认，**不得静默按新城市推进、也不得静默沿用旧城市**
  - \`result.areaLevelQuery=true\` 表示查询词只是区/市级行政区名，坐标是**行政区代表点**而非候选人真实位置：仍可据此查岗，但据此算出的门店距离只能按"约 X 公里（按 XX 估算）"的估算口径表述（岗位工具结果会自动带估算标记），或先追问候选人具体位置/商圈/定位
- \`resolution=ambiguous\` + \`candidates\`：多城市同名，**禁止默认选第一个**；列出 candidates 中实际返回的城市，请候选人选择，选定后带上 city 重调本工具
- \`resolution=needs_confirmation\`：解析结果须候选人确认后才能用——原地址未被逐字回显；或你传的 city 没有出处被忽略（即使命中同城）；或全国搜索的城市与候选人所在兼职群/在途预约门店城市不一致。严格按 \`_replyInstruction\` 用一句话向候选人确认，确认前**禁止**采用坐标查岗、禁止宣称已确认城市
- \`errorType\`：按各错误类型的 \`_replyInstruction\` 行事

## 边界
- 本轮高置信地点线索只用于帮助补 city 和理解意图，不替代 geocode
- 学校 / 校区 / 学院 / 小学部 / 附小 等地点名只是位置线索，不得据此推断候选人学历

## 空头承诺禁忌
- 未拿到经纬度前，不得声称已查到附近门店或复述历史门店事实；位置确认前只能说明准备查询附近岗位`;

const inputSchema = z.object({
  address: z.string().describe('待解析的地名或地址文本，可包含行政区、商圈、地标、街道或具体站名'),
  city: z
    .string()
    .nullable()
    .optional()
    .describe(
      '城市级名称。可选：' +
        '仅填写候选人明示、会话记忆、已在兼职群、本人在途预约门店、最近有效城市问答确认或本轮确权的城市；' +
        '没有这些出处时留空（不传或传 null）让工具判定，不得凭通识或地名推测填入。' +
        '万达广场/天街/购物中心等跨城同名地点也遵循此出处要求。',
    ),
});

/** 把 GeocodeCandidate 裁剪成给 LLM 反问时够用的最小信息。 */
function toAmbiguousView(c: GeocodeCandidate): AmbiguousCandidateView {
  return {
    city: c.city,
    district: c.district,
    formattedAddress: c.formattedAddress,
    poiName: c.poiName,
  };
}

/** 把单城 GeocodeCandidate 投回旧 GeocodeResult shape，保证下游 prompt 模板兼容。 */
function toResultPayload(c: GeocodeCandidate, queryAddress?: string) {
  return {
    formattedAddress: c.formattedAddress,
    province: c.province,
    city: c.city,
    district: c.district,
    township: c.township,
    longitude: c.longitude,
    latitude: c.latitude,
    // 区/城市级粗粒度查询标记：候选人只报了区名/市名时，锚点坐标是行政区代表点，
    // 与候选人真实位置可能相差数公里——下游据此禁止输出精确距离。
    areaLevelQuery: isAreaLevelQuery(queryAddress, c),
  };
}

/**
 * 查询词是否只是区/县/市级行政区名（如"松江"、"浦东新区"、"常州"）。
 * 这类查询即使命中 unique 锚点，代表的也只是"整个行政区"，
 * 基于锚点算出的门店距离不能当候选人的真实距离说给候选人。
 * 区级命中时同时返回匹配到的行政区名（用于下游"按 XX 估算"文案）。
 */
function resolveAreaLevelAnchor(
  queryAddress: string | undefined,
  c: GeocodeCandidate,
): { areaLevelQuery: boolean; areaName: string | null } {
  const normalized = (queryAddress ?? '').trim().replace(/(?:新区|市|区|县)$/, '');
  if (normalized.length < 2) return { areaLevelQuery: false, areaName: null };
  const district = (c.district ?? '').replace(/(?:新区|市|区|县)$/, '');
  const city = (c.city ?? '').replace(/(?:新区|市|区|县)$/, '');
  if (normalized === district) return { areaLevelQuery: true, areaName: c.district || null };
  if (normalized === city) return { areaLevelQuery: true, areaName: c.city || null };
  return { areaLevelQuery: false, areaName: null };
}

function isAreaLevelQuery(queryAddress: string | undefined, c: GeocodeCandidate): boolean {
  return resolveAreaLevelAnchor(queryAddress, c).areaLevelQuery;
}

/**
 * 城市结论前置披露（方案 11.4 B-2）：geocode 已成功解析城市甚至具体点位时，
 * 模型仍会反问"你在哪个城市"或误报"没找到"（badcase k1kfdc22/xpkhj9w1/ela0e6pt）。
 * 把解析结论渲染成结果对象的第一个字段，让模型在读到坐标细节前先看到城市已确认。
 */
function buildCityDisclosure(c: GeocodeCandidate, queryAddress: string | undefined): string {
  const { areaLevelQuery, areaName } = resolveAreaLevelAnchor(queryAddress, c);
  if (areaLevelQuery) {
    return `已确认城市：${c.city}（已定位到行政区代表点：${areaName ?? c.city}）`;
  }
  const poiLabel = c.poiName?.trim() || c.formattedAddress;
  return `已确认城市：${c.city}；已定位到 ${poiLabel}（精确坐标）`;
}

/**
 * 会话记忆城市与本次解析城市冲突时的知情披露（方案 11.4：不静默覆盖，
 * 也不静默沿用旧城市——由模型向候选人做一句确认后再推进）。
 *
 * 会话侧城市过不了行政区认领时不提冲突：脏写入（`hello`/`null`/整句）会制造假冲突，
 * 而提示的后果是真的——候选人刚发完定位还要被反问一句城市。写入侧已收紧
 * （isPlausibleCityValue），这里再兜一道：存量脏值与未来新形态都不该把多余反问推到
 * 候选人面前。
 */
function buildSessionCityConflictNotice(
  context: ToolBuildContext,
  c: GeocodeCandidate,
): string | null {
  const sessionCityRaw = context.archive.sessionFacts?.preferences?.city?.value ?? null;
  const sessionCity = normalizeCityName(sessionCityRaw);
  const resolvedCity = normalizeCityName(c.city);
  if (!sessionCity || !resolvedCity || sessionCity === resolvedCity) return null;
  if (!isRecognizedCityName(sessionCity)) return null;
  return (
    `⚠️ 本次解析城市（${c.city}）与会话记忆中的意向城市（${sessionCityRaw}）不一致。` +
    '禁止静默按新城市推进，也禁止静默沿用旧城市：先向候选人用一句话确认以哪个城市为准，确认后再据此查岗。'
  );
}

/**
 * 代词/方位词碎片，不是地名：整串等于这些词（或仅由它们拼成）时不打高德。
 * 只收"绝不可能是地名"的日常词，避免误伤真实短地名（"南澳""吴中"照常查）。
 */
const NON_PLACE_ADDRESS_PATTERN =
  /^(?:有我|我|我在|我这|我这边|我这里|这边|这里|那边|那里|附近|我附近|附近的|我家|家里|家附近|住处|我住的地方|住的地方|我住这|我住这里|我住的附近|周边|周围|本地|当地|这附近)(?:附近|这边|这里|周边)?$/u;

/** 模型传入 city 被出处门忽略的事实；必须回执给模型，禁止静默全国搜后宣称「已确认城市」。 */
interface IgnoredCityInput {
  requestedCity: string;
  reason: 'city_conflict' | 'city_unverified';
  /** city_conflict 时的会话记忆城市。 */
  expectedCity?: string;
}

interface CityProvenance {
  /** 实际用于限定搜索的城市；无出处时为 null（全国搜索）。 */
  city: string | null;
  ignored: IgnoredCityInput | null;
}

/** 以工具上下文跑一次城市出处门（与 invite 同一套出处档）。 */
function evaluateCityProvenance(
  context: ToolBuildContext,
  requestedCity: string,
  ignoreSessionCity = false,
): InviteCityGateVerdict {
  const cityFact = context.archive.sessionFacts?.preferences?.city;
  const sessionCity =
    typeof cityFact === 'string'
      ? cityFact
      : cityFact && typeof cityFact === 'object' && 'value' in cityFact
        ? String(cityFact.value ?? '') || null
        : null;
  return evaluateInviteCityGate({
    requestedCity,
    sessionCity: ignoreSessionCity ? null : sessionCity,
    userTexts: extractUserTexts(context.turnInput.messages),
    geoSignalCities: context.ledger.geo.signalCities,
    turnResolvedCities: [
      ...context.ledger.geo.anchors.map((anchor) => anchor.city),
      context.turnInput.geocodeLocationAnchor?.city ?? '',
    ].filter(Boolean),
    turnVisualSheets: context.ledger.visual.factSheets,
    ...collectCityGateContextInputs(context),
  });
}

/**
 * geocode.city 与 invite.city 共用一套出处门：模型参数本身不构成城市证据。
 * 无出处/与会话事实冲突时不报错、不采信，降级为 city=null 让 geocode 三态裁决——但必须把
 * 「被忽略」这件事带回给模型（BadCase 复核 [17]：city=佛山 被静默丢弃，全国搜「王府井」唯一命中
 * 北京并宣称已确认城市）。
 */
function resolveProvenancedCity(
  context: ToolBuildContext,
  requestedCity: string | null,
): CityProvenance {
  if (!requestedCity) return { city: null, ignored: null };
  const verdict = evaluateCityProvenance(context, requestedCity);
  if (verdict.decision === 'allow') return { city: requestedCity, ignored: null };
  return {
    city: null,
    ignored: {
      requestedCity,
      reason: verdict.reason,
      ...(verdict.expectedCity ? { expectedCity: verdict.expectedCity } : {}),
    },
  };
}

function buildCityIgnoredNotice(ignored: IgnoredCityInput): string {
  const why =
    ignored.reason === 'city_conflict'
      ? `会话记忆城市为「${ignored.expectedCity ?? ''}」且候选人本会话没有提到过「${ignored.requestedCity}」`
      : `候选人原话、会话记忆、所在兼职群、在途预约和本轮解析里都找不到「${ignored.requestedCity}」`;
  return (
    `⚠️ 你传入的 city=「${ignored.requestedCity}」没有出处（${why}），本次未按该城市限定、按全国搜索。` +
    '禁止向候选人宣称已确认该城市；候选人确在该城市的话，先让候选人亲口说出或确认城市，再带 city 重调本工具。'
  );
}

/** 明示 city 被忽略的原因；搜索结果不能反过来给被拒绝的城市参数作证。 */
function withCityIgnoredNotice(result: Record<string, unknown>, ignored: IgnoredCityInput) {
  return {
    _cityIgnored: buildCityIgnoredNotice(ignored),
    _cityIgnoredReason: ignored.reason,
    ...result,
  };
}

/** 候选人所在兼职群城市 + 在途预约门店城市（归一后去重）；全国搜 unique 的交叉核对基准。 */
function collectContextCities(context: ToolBuildContext): string[] {
  const inputs = collectCityGateContextInputs(context);
  const cities = new Set<string>();
  for (const city of [
    ...(inputs.realtimeGroupCities ?? []),
    ...(inputs.bookingStoreCities ?? []),
  ]) {
    const normalized = normalizeCityName(city);
    if (normalized) cities.add(normalized);
  }
  return [...cities];
}

/**
 * city=null 全国搜索得到 unique 时的城市交叉核对（BadCase 复核 [17]）：
 * - 模型传的 city 被忽略 → 需候选人确认，搜索偶然命中同城也不能替候选人确认；
 * - 全国搜城市与候选人所在兼职群/在途预约门店城市不一致、且该城市自身没有任何出处 → 同样需确认。
 * 返回 null 表示可以照常走 unique。
 */
function resolveNationwideCityConfirmation(params: {
  context: ToolBuildContext;
  candidate: GeocodeCandidate;
  queryAddress: string;
  ignored: IgnoredCityInput | null;
}) {
  const { context, candidate, queryAddress, ignored } = params;
  const resolvedCity = normalizeCityName(candidate.city);
  if (!resolvedCity) return null;
  const candidateLabel = candidate.poiName?.trim() || candidate.formattedAddress;

  if (ignored) {
    return {
      resolution: 'needs_confirmation' as const,
      candidateLabel,
      resolvedCity: candidate.city,
      ignoredCity: ignored.requestedCity,
      _replyInstruction:
        `你传入的 city=「${ignored.requestedCity}」没有出处，本次已按全国搜索，` +
        `“${queryAddress}”解析到「${candidate.city}」（${candidateLabel}），搜索命中不等于候选人确认所在城市。` +
        `禁止向候选人宣称已确认城市、禁止按「${candidate.city}」查岗或推荐、禁止把「${candidate.city}」当作候选人所在城市。` +
        `先用一句话向候选人确认所在城市（如“你是在${ignored.requestedCity}这边对吧？”），候选人确认后带 city 重调本工具。`,
    };
  }

  const contextCities = collectContextCities(context);
  if (contextCities.length === 0 || contextCities.includes(resolvedCity)) return null;
  // 解析城市自身有出处（候选人亲口说过 / 区名推断 / 本轮确权 / 地图截图 / 问答确认）时放行：
  // 候选人可能刚换城市，群与预约城市只是旧线索。
  const evidence = evaluateCityProvenance(context, candidate.city, true);
  if (evidence.decision === 'allow' && evidence.matchedBy !== 'turn_geocode') return null;
  const contextLabel = contextCities.join('、');
  return {
    resolution: 'needs_confirmation' as const,
    candidateLabel,
    resolvedCity: candidate.city,
    contextCities,
    _replyInstruction:
      `“${queryAddress}”全国搜索唯一落在「${candidate.city}」（${candidateLabel}），` +
      `但候选人当前所在兼职群/在途预约门店显示在「${contextLabel}」，两者不一致。` +
      `禁止宣称已确认城市、禁止按「${candidate.city}」查岗或把它当作候选人所在城市；` +
      `先用一句话向候选人确认是在「${contextLabel}」还是「${candidate.city}」，确认后带 city 重调本工具。`,
  };
}

/**
 * unique 解析结果的统一出口：记录回合锚点（11.3）+ 前置城市披露（11.4）。
 * `_cityConfirmed` 必须是返回对象的第一个字段——序列化后模型最先读到城市结论。
 */
function buildUniqueResult(params: {
  context: ToolBuildContext;
  candidate: GeocodeCandidate;
  queryAddress: string;
  extra?: Record<string, unknown>;
  /**
   * 跨城纠偏时必须逐字回显的原始地址：置信度再高也要回显，否则先让候选人确认
   * （「南海桂城上海村」被纠偏成上海「海上海」）。
   */
  requireEchoOf?: string;
  /** 本次是 city=null 的全国搜索（无锚点/无地址行政回显印证）；城市确权只记 medium。 */
  nationwideSearch?: boolean;
  ignoredCity?: IgnoredCityInput | null;
}) {
  const { context, candidate, queryAddress, extra, requireEchoOf, nationwideSearch, ignoredCity } =
    params;
  if (ignoredCity) {
    const confirmation = resolveNationwideCityConfirmation({
      context,
      candidate,
      queryAddress,
      ignored: ignoredCity,
    });
    if (confirmation) return confirmation;
  }
  const echoTarget = requireEchoOf ?? queryAddress;
  const mustEcho = requireEchoOf !== undefined || candidate.confidence !== 'high';
  if (mustEcho && !candidateEchoesQuery(candidate, echoTarget)) {
    return {
      resolution: 'needs_confirmation' as const,
      candidateLabel: candidate.poiName?.trim() || candidate.formattedAddress,
      _replyInstruction:
        `“${echoTarget}”与解析结果“${candidate.poiName?.trim() || candidate.formattedAddress}”不是逐字同一地点。` +
        '先把解析到的标准地点回显给候选人确认；确认前禁止采用坐标查岗。候选人确认后再按该标准地点重调 geocode。',
      ...(extra ?? {}),
    };
  }
  recordResolvedAnchor(context, candidate, queryAddress, nationwideSearch === true);
  const conflictNotice = buildSessionCityConflictNotice(context, candidate);
  return {
    _cityConfirmed: buildCityDisclosure(candidate, queryAddress),
    ...(conflictNotice ? { _cityConflictNotice: conflictNotice } : {}),
    resolution: 'unique' as const,
    result: toResultPayload(candidate, queryAddress),
    ...(extra ?? {}),
  };
}

/** 查询原文须被返回的结构化地址/POI 逐字承接；纠错改字必须先让候选人确认。 */
function candidateEchoesQuery(candidate: GeocodeCandidate, queryAddress: string): boolean {
  const query = normalizeReferenceText(queryAddress);
  if (!query) return false;
  return [candidate.poiName, candidate.township, candidate.district, candidate.formattedAddress]
    .map(normalizeReferenceText)
    .filter((value) => value.length >= 2)
    .some((value) => value.includes(query) || query.includes(value));
}

/**
 * 把本次 unique 解析结果写入回合上下文（方案 11.3 锚点精度确定性传递）：
 * duliday_job_list 按坐标匹配读取，区级锚点下距离渲染为估算口径，
 * 不依赖模型转抄 areaLevelQuery。
 */
function recordResolvedAnchor(
  context: ToolBuildContext,
  c: GeocodeCandidate,
  queryAddress: string | undefined,
  nationwideSearch: boolean,
): void {
  if (!Number.isFinite(c.longitude) || !Number.isFinite(c.latitude)) return;
  const { areaLevelQuery, areaName } = resolveAreaLevelAnchor(queryAddress, c);
  // 城市确权穿线（geocode 两次确认沈阳，invite 门仍报 city 无依据）：
  // unique 解析即城市确认，暂存 ledger 供回合收尾写 pref.city，让 invite 城市门
  // 的 session_fact 档与 [兼职群资源] 段在后续轮直接可用。
  // anchor 与 attestation 的成对写入由 recordGeoResolution 统一维护。
  context.ledger.recordGeoResolution({
    longitude: c.longitude,
    latitude: c.latitude,
    areaLevelQuery,
    areaName,
    city: c.city || null,
    district: c.district ?? null,
    evidence: `geocode 唯一解析：${c.formattedAddress?.trim() || queryAddress?.trim() || c.city?.trim() || ''}`,
    source: 'geocode_unique',
    nationwideSearch,
  });
}

function normalizeReferenceText(value: string): string {
  return value.replace(/[\s，。！？、；：,.!?;:（）()【】\[\]"']/g, '');
}

function candidateMatchesAnchor(
  candidate: GeocodeCandidate,
  anchor: GeocodeLocationAnchor,
): boolean {
  const expectedCity = normalizeCityName(anchor.city);
  const resolvedCity = normalizeCityName(candidate.city);
  if (expectedCity && (!resolvedCity || resolvedCity !== expectedCity)) return false;

  if (anchor.districts.length === 0) return true;
  const returnedAdministrativeAreas = [candidate.district, candidate.township].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  if (returnedAdministrativeAreas.length === 0) return false;
  return anchor.districts.some((district) =>
    returnedAdministrativeAreas.some((returnedArea) =>
      candidateDistrictMatchesAddress([normalizeDistrictForLookup(district)], returnedArea),
    ),
  );
}

function queryMatchesAnchorReference(address: string, anchor: GeocodeLocationAnchor): boolean {
  if (anchor.source === 'current_user') return true;

  const query = normalizeReferenceText(address);
  const reference = normalizeReferenceText(anchor.referenceText ?? '');
  const anchorTokens = [anchor.city, ...anchor.districts]
    .filter((token): token is string => Boolean(token))
    .flatMap((token) => [token, token.replace(/[市区县]$/, '')])
    .filter(Boolean);
  if (!query) return false;
  if (!reference) {
    if (anchor.source === 'session_memory') return true;
    return anchorTokens.some((token) => query.includes(normalizeReferenceText(token)));
  }
  if (anchorTokens.some((token) => query.includes(normalizeReferenceText(token)))) return true;

  let core = query;
  for (const token of anchorTokens) {
    core = core.replaceAll(normalizeReferenceText(token), '');
  }
  if (core.length >= 2 && (reference.includes(core) || core.includes(reference))) return true;

  // “同济店”与“同济园”这类同一地标的轻微尾字差异：至少两个连续前缀字相同。
  let commonPrefix = 0;
  while (commonPrefix < core.length && reference.includes(core.slice(0, commonPrefix + 1))) {
    commonPrefix += 1;
  }
  return commonPrefix >= 2;
}

/** 候选是否落在锚点城市；锚点没有城市时不构成跨城判断依据，视为同城。 */
function candidateInAnchorCity(
  candidate: GeocodeCandidate,
  anchor: GeocodeLocationAnchor,
): boolean {
  const expectedCity = normalizeCityName(anchor.city);
  if (!expectedCity) return true;
  return normalizeCityName(candidate.city) === expectedCity;
}

function buildAmbiguousResult(address: string, byCity: Map<string, GeocodeCandidate>) {
  const candidatesView = Array.from(byCity.values()).slice(0, 3).map(toAmbiguousView);
  return {
    resolution: 'ambiguous' as const,
    candidates: candidatesView,
    _replyInstruction:
      `"${address}" 在多个城市都有同名 POI（${candidatesView.map((c) => c.city).join('、')}）。` +
      '把候选城市清单列给候选人让其确认，禁止默认选第一个；' +
      '确认后以 city 参数重新调用本工具。',
  };
}

function buildContextualAddress(address: string, anchor: GeocodeLocationAnchor): string {
  const normalizedAddress = normalizeReferenceText(address);
  const parts: string[] = [];
  const city = anchor.city?.trim();
  const district = anchor.districts.length === 1 ? anchor.districts[0]?.trim() : undefined;
  if (city && !normalizedAddress.includes(normalizeReferenceText(city))) parts.push(city);
  if (district && !normalizedAddress.includes(normalizeReferenceText(district)))
    parts.push(district);
  parts.push(address.trim());
  return parts.join('');
}

function buildAnchorMismatchError(
  address: string,
  city: string | null,
  anchor: GeocodeLocationAnchor,
  candidates: GeocodeCandidate[],
) {
  return buildToolError({
    errorType: TOOL_ERROR_TYPES.GEOCODE_ANCHOR_MISMATCH,
    replyInstruction:
      '当前已确认的位置上下文与本次地理解析结果不一致。禁止采用本次坐标、禁止据此查询或推荐附近岗位。' +
      '请向候选人确认更具体的区/地标，或请对方发送位置，再重新调用 geocode。',
    details: {
      address,
      city,
      anchorCity: anchor.city,
      anchorDistricts: anchor.districts,
      anchorSource: anchor.source,
      resolvedAreas: candidates.slice(0, 3).map((candidate) => ({
        city: candidate.city,
        district: candidate.district,
        formattedAddress: candidate.formattedAddress,
      })),
    },
  });
}

export function buildGeocodeTool(geocodingService: GeocodingService): ToolBuilder {
  return (context) => {
    const runGeocode = async ({ address, city }: z.infer<typeof inputSchema>) => {
      const trimmedAddress = address?.trim() ?? '';
      const requestedCity = city?.trim() || null;
      const cityProvenance = resolveProvenancedCity(context, requestedCity);
      const result = await resolveAddress(trimmedAddress, cityProvenance);
      // 被出处门忽略的 city 必须回执：静默全国搜后模型会把别城结果当「已确认城市」。
      return cityProvenance.ignored
        ? withCityIgnoredNotice(result as Record<string, unknown>, cityProvenance.ignored)
        : result;
    };

    const resolveAddress = async (trimmedAddress: string, cityProvenance: CityProvenance) => {
      const normalizedCity = cityProvenance.city;

      if (!trimmedAddress) {
        return buildToolError({
          errorType: TOOL_ERROR_TYPES.GEOCODE_UNRESOLVED_ADDRESS,
          replyInstruction: 'address 不能为空。向候选人确认更具体的地名/地址后再调用本工具。',
          details: { address: trimmedAddress, city: normalizedCity },
        });
      }

      // 非地名词兜底：模型把"有我附近/我这边/家里"里的代词碎片当地址传进来（badcase 6k394ya0：
      // address="有我"，回复里还把它当地名复述"有我这个地方没定位到"）。
      if (NON_PLACE_ADDRESS_PATTERN.test(trimmedAddress)) {
        return buildToolError({
          errorType: TOOL_ERROR_TYPES.GEOCODE_UNRESOLVED_ADDRESS,
          replyInstruction:
            `"${trimmedAddress}" 不是地名，是候选人句子里的代词/方位词碎片，禁止向候选人复述它、` +
            '也禁止说"这个地方没定位到"。候选人尚未给出可定位的地点：直接请候选人发一个定位或说商圈/地铁站/详细地址。',
          details: { address: trimmedAddress, city: normalizedCity, reason: 'not_a_place_name' },
        });
      }

      // 真歧义兜底：未传 city + 命中通用后缀黑名单 → 不打高德，直接让 Agent 反问
      if (!normalizedCity && hasGenericAmbiguousSuffix(trimmedAddress)) {
        return buildToolError({
          errorType: TOOL_ERROR_TYPES.GEOCODE_AMBIGUOUS_SUFFIX,
          replyInstruction:
            '该地名属于跨城同名的通用后缀（万达广场/天街/火车站/购物中心 等），' +
            '禁止凭通识默认任一城市。先中性询问候选人所在城市，' +
            '反问不得带具体城市名；候选人答完后带上 city 重新调用本工具。',
          details: { address: trimmedAddress },
        });
      }

      try {
        const candidates = await geocodingService.searchCandidates(trimmedAddress, normalizedCity);

        const locationAnchor = context.turnInput.geocodeLocationAnchor;
        const applicableAnchor =
          locationAnchor && queryMatchesAnchorReference(trimmedAddress, locationAnchor)
            ? locationAnchor
            : undefined;

        if (applicableAnchor) {
          const matchingCandidates = candidates.filter((candidate) =>
            candidateMatchesAnchor(candidate, applicableAnchor),
          );
          if (matchingCandidates.length > 0) {
            const anchor = pickAnchorCandidate(matchingCandidates);
            return buildUniqueResult({
              context,
              candidate: anchor,
              queryAddress: trimmedAddress,
              ignoredCity: cityProvenance.ignored,
              nationwideSearch: !normalizedCity,
            });
          }

          // 地址本身写明了另一城市的区县/街镇（「南海桂城上海村」→ 佛山南海区、桂城街道）：
          // 地址证据比规则锚点更具体，按地址采纳，不纠偏到锚点城市。
          const administrativelyEchoed = candidates.filter(
            (candidate) =>
              !candidateInAnchorCity(candidate, applicableAnchor) &&
              candidateAdministrativeAreaEchoedInAddress(candidate, trimmedAddress),
          );
          if (administrativelyEchoed.length > 0) {
            const echoedByCity = groupCandidatesByCity(administrativelyEchoed);
            if (echoedByCity.size === 1) {
              return buildUniqueResult({
                context,
                candidate: pickAnchorCandidate(administrativelyEchoed),
                queryAddress: trimmedAddress,
                ignoredCity: cityProvenance.ignored,
                nationwideSearch: !normalizedCity,
                extra: {
                  contextCorrection: {
                    applied: false,
                    reason: 'address_administrative_echo',
                    anchorCity: applicableAnchor.city,
                    source: applicableAnchor.source,
                  },
                },
              });
            }
            return buildAmbiguousResult(trimmedAddress, echoedByCity);
          }

          const contextualAddress = buildContextualAddress(trimmedAddress, applicableAnchor);
          const contextualCity = applicableAnchor.city?.trim() || normalizedCity;
          const shouldRetry =
            contextualAddress !== trimmedAddress || contextualCity !== normalizedCity;
          const contextualCandidates = shouldRetry
            ? await geocodingService.searchCandidates(contextualAddress, contextualCity)
            : candidates;
          const contextualMatches = contextualCandidates.filter((candidate) =>
            candidateMatchesAnchor(candidate, applicableAnchor),
          );
          if (contextualMatches.length > 0) {
            const anchor = pickAnchorCandidate(contextualMatches);
            // 首查完全不在锚点城市（含首查为空）时，这次纠偏是跨城改判：结果必须逐字回显
            // 候选人原地址，置信度再高也不能直接宣告已确认城市。
            const crossCityCorrection = !candidates.some((candidate) =>
              candidateInAnchorCity(candidate, applicableAnchor),
            );
            return buildUniqueResult({
              context,
              candidate: anchor,
              queryAddress: contextualAddress,
              ignoredCity: cityProvenance.ignored,
              nationwideSearch: !contextualCity,
              ...(crossCityCorrection ? { requireEchoOf: trimmedAddress } : {}),
              extra: {
                contextCorrection: {
                  applied: true,
                  originalAddress: trimmedAddress,
                  resolvedAddress: contextualAddress,
                  source: applicableAnchor.source,
                },
              },
            });
          }

          return buildAnchorMismatchError(
            trimmedAddress,
            normalizedCity,
            applicableAnchor,
            contextualCandidates.length > 0 ? contextualCandidates : candidates,
          );
        }

        if (candidates.length === 0) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.GEOCODE_UNRESOLVED_ADDRESS,
            replyInstruction:
              '地名无法解析。先核对 address 与 city 是否对应；' +
              '若候选人原话本就模糊（如只给出小区/楼栋俗称），向候选人确认更具体的地址或地标，' +
              '再重新调用本工具；不要凭已有信息硬猜地点。',
            details: { address: trimmedAddress, city: normalizedCity },
          });
        }

        // 单城唯一命中：按精度择优（道路名 POI 易锚偏，优先地铁站），而非无脑取第一条
        const uniqueByCity = groupCandidatesByCity(candidates);
        if (uniqueByCity.size <= 1) {
          const anchor = pickAnchorCandidate(candidates);

          // 跨城同名区兜底：未传 city + address 明确报了"X区/县"，但高德选中的 POI 落在
          // 另一个区——说明无 city 时被模糊匹配到了异城同名地点（线上 case：候选人"雨花区板桥"
          // → 高德"长沙县板桥小区"）。单城返回会被当 unique 全盘信任，故这里改报错让 Agent
          // 先反问城市，而不是凭错城坐标判定"无岗"后静默收口。
          if (!normalizedCity) {
            const addrStems = extractDistrictStems(trimmedAddress);
            if (
              addrStems.length > 0 &&
              !candidateDistrictMatchesAddress(addrStems, anchor.district)
            ) {
              return buildToolError({
                errorType: TOOL_ERROR_TYPES.GEOCODE_DISTRICT_CITY_MISMATCH,
                replyInstruction:
                  '候选人报的区名在多个城市同名，未带城市时本次解析可能落到错误城市，' +
                  '禁止采用本次坐标、也禁止据此判定"该城市无岗/无群"后收口。' +
                  '先中性询问候选人所在城市，不得带具体城市名，' +
                  '拿到城市后带 city 参数重新调用本工具。',
                details: {
                  address: trimmedAddress,
                  resolvedCity: anchor.city,
                  resolvedDistrict: anchor.district,
                },
              });
            }

            // 全国搜 unique 的城市交叉核对：模型传的 city 被忽略却落到别城、或与候选人所在群/
            // 在途预约门店城市不一致时，先让候选人确认，不写锚点、不宣称已确认城市。
            const confirmation = resolveNationwideCityConfirmation({
              context,
              candidate: anchor,
              queryAddress: trimmedAddress,
              ignored: cityProvenance.ignored,
            });
            if (confirmation) return confirmation;
          }

          return buildUniqueResult({
            context,
            candidate: anchor,
            queryAddress: trimmedAddress,
            ignoredCity: cityProvenance.ignored,
            nationwideSearch: !normalizedCity,
          });
        }

        // 多城歧义：列出候选，由 Agent 反问
        return buildAmbiguousResult(trimmedAddress, uniqueByCity);
      } catch (err) {
        logger.error('地理编码失败', err);
        return buildToolError({
          errorType: TOOL_ERROR_TYPES.GEOCODE_FAILED,
          replyInstruction:
            '地理编码接口暂时不可用。不要把异常信息原文转述给候选人；用招募者口吻说"这边稍等下"，' +
            '可先基于已知城市/区域用 duliday_job_list 兜底，或调用 request_handoff 转人工。',
          details: { reason: toErrorMessage(err) || '未知错误' },
        });
      }
    };

    return tool({
      description: DESCRIPTION,
      inputSchema,
      // 出处判定只进原始输出（tool_calls 留档供校准），不进模型可见结果，观测期不影响决策。
      toModelOutput: ({ output }) => ({ type: 'json', value: omitAddressProvenance(output) }),
      execute: async (input) => {
        const provenance = buildAddressProvenance(context, input.address);
        const result = await runGeocode(input);
        if (provenance.verdict === 'unattested' && provenance.assistantOnly) {
          // 地址原文可能是候选人住址，日志只留元数据；原文在 tool_calls 入参留档可查。
          logger.warn(
            `geocode 地址只出现在 Agent 自己的消息里，找不到候选人/真人/工具出处（shadow 观测，未干预）: ` +
              `sessionId=${context.session.sessionId} matchedBy=${provenance.matchedBy ?? 'none'} ` +
              `addressChars=${Array.from(input.address).length}`,
          );
        }
        return { ...result, _addressProvenance: provenance };
      },
    });
  };
}

/** 汇总本轮可作为地址出处的外生语料，交给纯函数判定。 */
function buildAddressProvenance(context: ToolBuildContext, address: string) {
  const corpusBlocks = context.turnInput.corpusBlocks ?? [];
  const dialogueMessages = corpusBlocks.length
    ? selectEvidenceDialogueMessages(corpusBlocks)
    : (context.turnInput.messages ?? []);
  const candidateTexts = corpusBlocks.length
    ? extractCandidateTextsFromCorpus(corpusBlocks)
    : extractUserTexts(context.turnInput.messages ?? []);
  const humanAgentTexts: string[] = [];
  const assistantTexts: string[] = [];
  for (const turn of extractDialogueTurns(dialogueMessages)) {
    if (turn.role !== 'assistant') continue;
    if (turn.text.includes(HUMAN_AGENT_MESSAGE_MARKER)) {
      humanAgentTexts.push(turn.text.replace(HUMAN_AGENT_MESSAGE_MARKER, ''));
    } else {
      assistantTexts.push(turn.text);
    }
  }
  const focusJob = context.archive.currentFocusJob;
  const toolResultTexts = [
    ...corpusBlocks
      .filter((block) => block.domain === 'tool_result')
      .map((block) =>
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
      ),
    focusJob?.storeName ?? '',
    focusJob?.storeAddress ?? '',
    ...context.ledger.visual.factSheets.map((entry) => JSON.stringify(entry.sheet)),
  ].filter(Boolean);
  return evaluateGeocodeAddressProvenance({
    address,
    candidateTexts,
    humanAgentTexts,
    assistantTexts,
    toolResultTexts,
    dialogueMessages,
  });
}

function omitAddressProvenance(output: unknown) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output as never;
  const { _addressProvenance: _omitted, ...rest } = output as Record<string, unknown>;
  return rest as never;
}

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

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import type { GeocodeCandidate } from '@infra/geocoding/geocoding.types';
import {
  candidateDistrictMatchesAddress,
  extractDistrictStems,
  groupCandidatesByCity,
  pickAnchorCandidate,
} from '@infra/geocoding/geocoding-candidate-ranker.util';
import {
  hasGenericAmbiguousSuffix,
  normalizeCityName,
  normalizeDistrictForLookup,
} from '@memory/facts/geo-mappings';
import type {
  GeocodeLocationAnchor,
  ToolBuildContext,
  ToolBuilder,
} from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

const logger = new Logger('geocode');

/** Agent 看到的 ambiguous 候选条目（裁剪掉冗余字段，留下足够反问的信息）。 */
interface AmbiguousCandidateView {
  city: string;
  district: string;
  formattedAddress: string;
  poiName: string;
}

const DESCRIPTION = `将地名或地址解析为标准化的省/市/区/镇层级和经纬度坐标。
例如："九亭" → 上海市松江区九亭镇 (121.32, 31.11)

## 何时调用
- 候选人提到商圈/地标/街道/详细地址等自由位置线索（如"九亭"、"陆家嘴"、"我在 XX 附近"），且你准备做具体岗位/门店推荐时
- 附近推荐、距离比较、范围筛选只是最明显的触发场景，不是唯一场景
- 只要候选人给了可用位置线索，且你准备做具体岗位/门店推荐，本工具就是主链路的前置步骤

## 何时不调用
- 只按区域/品牌/岗位做普通查岗时，不要为了 geocode 额外补问城市
- 行政区域（静安区/浦东新区等）可直接查岗，不必经过 geocode
- 当前上下文已足够确定城市时，不要对明显属于该城市的区域再做常识性反问
- 候选人本轮的 [位置分享] 已自带经纬度时，直接使用即可，不必再 geocode 一次

## 作用
1. 补全行政区划：将模糊地名解析为完整的省/市/区/街道，用返回的 district 作为 duliday_job_list.regionNameList
2. 获取经纬度：用返回的 latitude/longitude 组装 duliday_job_list.location；需要按 10km / 5km 等范围筛选时，把米数写入 location.range

## 参数
- address 必传；当你判断该地点是地铁站时（如"七莘路"实指地铁站），传"X站"/"X地铁站"而非裸路名——裸路名会被当成整条道路、坐标可能锚到远端
- city 可选；按以下优先级判断要不要填：
  1. 候选人当前明示城市 / [本轮查询硬约束] 的城市 / [本轮高置信线索] 的城市 / [会话记忆] 任一存在 → 直接填入（哪怕本工具的 address 是商圈/地标，也要带上这个已知城市）
  2. 上面都没有，但你判断"地名→城市"是公认唯一对应（如"马陆"→上海嘉定、"光谷"→武汉、"中关村"→北京、"漕宝路地铁站"→上海），且地名**不**命中下面的"通用后缀黑名单" → 允许凭通识填城市
  3. 既无明示也无高置信通识，或地名命中黑名单 → city 留空（不传或传 null），由工具判定
- 不要为了 city 反复反问候选人——拿不准就留空让工具自己处理

## 通用后缀黑名单（命中即跨城同名，不允许凭通识填 city）
万达广场 / 万象城 / 吾悦广场 / 银泰 / 天街 / 印象城 / 大悦城 /
购物中心 / 商场 / 广场 / 步行街 / 美食街 /
大学 / 学院 / 医院 / 人民公园 / 人民广场 / 中心医院 /
裸通名的交通枢纽（"火车站""汽车站""长途汽车站"这类没有专名前缀的）

**带专名前缀的车站不算黑名单**："漕宝路地铁站""虹桥火车站"这类有具体站名的，
按上面第 2 条正常处理——有高置信通识就填 city（如"漕宝路"→上海），没把握就留空，
工具会全国搜索；真撞名时返回 ambiguous 候选清单再反问。

命中黑名单时 **city 必须留空**——工具会报 \`GEOCODE_AMBIGUOUS_SUFFIX\`，按 \`_replyInstruction\` 中性反问候选人所在城市，反问禁止带具体城市名。

## 返回三态
- \`resolution=unique\` + 扁平 \`result\`：单城唯一命中，直接把 result 当结果用，组装 location 走 duliday_job_list
  - **解析成功即城市已确认**：结果第一个字段 \`_cityConfirmed\` 已写明"已确认城市：XX"。**此后禁止再向候选人反问"你在哪个城市/你这边是哪儿"**，也禁止宣称"没找到这个位置"——应直接按已确认城市与坐标查岗。仅当结果带 \`_cityConflictNotice\`（本次解析城市与会话记忆城市冲突）时，按其指引向候选人做一句确认，**不得静默按新城市推进、也不得静默沿用旧城市**
  - \`result.areaLevelQuery=true\` 表示查询词只是区/市级行政区名，坐标是**行政区代表点**而非候选人真实位置：仍可据此查岗，但据此算出的门店距离只能按"约 X 公里（按 XX 估算）"的估算口径表述（岗位工具结果会自动带估算标记），或先追问候选人具体位置/商圈/定位
- \`resolution=ambiguous\` + \`candidates\`：多城市同名，**禁止默认选第一个**；按 candidates 里的 city 清单反问候选人"是 A 的 X 还是 B 的 X"，候选人选定后带上 city 重调本工具
- \`errorType\`：按各错误类型的 \`_replyInstruction\` 行事

## 边界
- 本轮高置信地点线索只用于帮助补 city 和理解意图，不替代 geocode
- 学校 / 校区 / 学院 / 小学部 / 附小 等地点名只是位置线索，不得据此推断候选人学历

## 空头承诺禁忌
- 未拿到经纬度前，不得说"我看了下附近 X 店"或复述历史门店事实；位置确认前只能说"我先帮你查一下附近的"`;

const inputSchema = z.object({
  address: z.string().describe('地名或地址文本（如 "九亭"、"人民广场"、"浦东新区张江"）'),
  city: z
    .string()
    .nullable()
    .optional()
    .describe(
      '城市名（如 "上海"、"北京"）。可选：' +
        '系统已明示城市 / 你对地名→城市映射有高置信通识时填入（含"漕宝路地铁站"这类带专名前缀的车站）；' +
        '若地名命中通用后缀黑名单（万达广场/天街/购物中心/裸通名车站 等跨城同名），' +
        '必须留空（不传或传 null）让工具判定。',
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
    // 与候选人真实位置可能相差数公里——下游据此禁止输出精确距离（badcase recvjyv0SKiqe3）。
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
 */
function buildSessionCityConflictNotice(
  context: ToolBuildContext,
  c: GeocodeCandidate,
): string | null {
  const sessionCityRaw = context.sessionFacts?.preferences?.city?.value ?? null;
  const sessionCity = normalizeCityName(sessionCityRaw);
  const resolvedCity = normalizeCityName(c.city);
  if (!sessionCity || !resolvedCity || sessionCity === resolvedCity) return null;
  return (
    `⚠️ 本次解析城市（${c.city}）与会话记忆中的意向城市（${sessionCityRaw}）不一致。` +
    '禁止静默按新城市推进，也禁止静默沿用旧城市：先向候选人用一句话确认以哪个城市为准' +
    '（如"你现在是在' +
    c.city +
    '这边找工作吗"），确认后再据此查岗。'
  );
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
}) {
  const { context, candidate, queryAddress, extra } = params;
  recordResolvedAnchor(context, candidate, queryAddress);
  const conflictNotice = buildSessionCityConflictNotice(context, candidate);
  return {
    _cityConfirmed: buildCityDisclosure(candidate, queryAddress),
    ...(conflictNotice ? { _cityConflictNotice: conflictNotice } : {}),
    resolution: 'unique' as const,
    result: toResultPayload(candidate, queryAddress),
    ...(extra ?? {}),
  };
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
): void {
  if (!Number.isFinite(c.longitude) || !Number.isFinite(c.latitude)) return;
  const { areaLevelQuery, areaName } = resolveAreaLevelAnchor(queryAddress, c);
  (context.geocodeResolvedAnchors ??= []).push({
    longitude: c.longitude,
    latitude: c.latitude,
    areaLevelQuery,
    areaName,
    city: c.city || null,
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
  if (!candidate.district?.trim()) return false;
  return anchor.districts.some((district) =>
    candidateDistrictMatchesAddress([normalizeDistrictForLookup(district)], candidate.district),
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
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ address, city }) => {
        const trimmedAddress = address?.trim() ?? '';
        const normalizedCity = city?.trim() || null;

        if (!trimmedAddress) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.GEOCODE_UNRESOLVED_ADDRESS,
            replyInstruction: 'address 不能为空。向候选人确认更具体的地名/地址后再调用本工具。',
            details: { address, city: normalizedCity },
          });
        }

        // 真歧义兜底：未传 city + 命中通用后缀黑名单 → 不打高德，直接让 Agent 反问
        if (!normalizedCity && hasGenericAmbiguousSuffix(trimmedAddress)) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.GEOCODE_AMBIGUOUS_SUFFIX,
            replyInstruction:
              '该地名属于跨城同名的通用后缀（万达广场/天街/火车站/购物中心 等），' +
              '禁止凭通识默认任一城市。先中性反问候选人所在城市（"你这边主要在哪个城市呀"），' +
              '反问不得带具体城市名；候选人答完后带上 city 重新调用本工具。',
            details: { address: trimmedAddress },
          });
        }

        try {
          const candidates = await geocodingService.searchCandidates(
            trimmedAddress,
            normalizedCity,
          );

          const locationAnchor = context.geocodeLocationAnchor;
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
              });
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
              return buildUniqueResult({
                context,
                candidate: anchor,
                queryAddress: contextualAddress,
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
                    '先中性反问候选人所在城市（"你这边主要在哪个城市呀"，不得带具体城市名），' +
                    '拿到城市后带 city 参数重新调用本工具。',
                  details: {
                    address: trimmedAddress,
                    resolvedCity: anchor.city,
                    resolvedDistrict: anchor.district,
                  },
                });
              }
            }

            return buildUniqueResult({
              context,
              candidate: anchor,
              queryAddress: trimmedAddress,
            });
          }

          // 多城歧义：列出候选，由 Agent 反问
          const candidatesView = Array.from(uniqueByCity.values()).slice(0, 3).map(toAmbiguousView);

          return {
            resolution: 'ambiguous' as const,
            candidates: candidatesView,
            _replyInstruction:
              `"${trimmedAddress}" 在多个城市都有同名 POI（${candidatesView
                .map((c) => c.city)
                .join('、')}）。` +
              '把候选城市清单列给候选人让其确认，禁止默认选第一个；' +
              '确认后以 city 参数重新调用本工具。',
          };
        } catch (err) {
          logger.error('地理编码失败', err);
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.GEOCODE_FAILED,
            replyInstruction:
              '地理编码接口暂时不可用。不要把异常信息原文转述给候选人；用招募者口吻说"这边稍等下"，' +
              '可先基于已知城市/区域用 duliday_job_list 兜底，或调用 request_handoff 转人工。',
            details: { reason: err instanceof Error ? err.message : '未知错误' },
          });
        }
      },
    });
  };
}

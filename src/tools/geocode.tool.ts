/**
 * 地理编码工具 — 将地名文本解析为标准化地址 + 经纬度
 *
 * 调用契约：city 不再强制必填，工具自己做歧义判定。
 * - 命中"通用后缀黑名单"（万达广场 / 火车站 / 购物中心 …）且未传 city → 报错让 Agent 反问
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
import { hasGenericAmbiguousSuffix } from '@memory/facts/geo-mappings';
import { ToolBuilder } from '@shared-types/tool.types';
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
- address 必传
- city 可选；按以下优先级判断要不要填：
  1. [候选人当前明示城市] / [系统解析高置信城市] / [会话记忆] 任一存在 → 直接填入
  2. 上面都没有，但你判断"地名→城市"是公认唯一对应（如"马陆"→上海嘉定、"光谷"→武汉、"中关村"→北京、"陆家嘴"→上海），且地名**不**命中下面的"通用后缀黑名单" → 允许凭通识填城市
  3. 既无明示也无高置信通识，或地名命中黑名单 → city 留空（不传或传 null），由工具判定
- 不要为了 city 反复反问候选人——拿不准就留空让工具自己处理

## 通用后缀黑名单（命中即跨城同名，不允许凭通识填 city）
万达广场 / 万象城 / 吾悦广场 / 银泰 / 天街 / 印象城 / 大悦城 /
购物中心 / 商场 / 广场 / 步行街 / 美食街 /
火车站 / 高铁站 / 汽车站 / 客运站 / 地铁站 /
大学 / 学院 / 医院 / 人民公园 / 人民广场 / 中心医院

命中黑名单时 **city 必须留空**——工具会报 \`GEOCODE_AMBIGUOUS_SUFFIX\`，按 \`_replyInstruction\` 中性反问候选人所在城市，反问禁止带具体城市名。

## 返回三态
- \`resolution=unique\` + 扁平 \`result\`：单城唯一命中，直接把 result 当结果用，组装 location 走 duliday_job_list
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
        '系统已明示城市 / 你对地名→城市映射有高置信通识时填入；' +
        '若地名命中通用后缀黑名单（万达广场/天街/火车站/购物中心 等跨城同名），' +
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
function toResultPayload(c: GeocodeCandidate) {
  return {
    formattedAddress: c.formattedAddress,
    province: c.province,
    city: c.city,
    district: c.district,
    township: c.township,
    longitude: c.longitude,
    latitude: c.latitude,
  };
}

export function buildGeocodeTool(geocodingService: GeocodingService): ToolBuilder {
  return () => {
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

          // 单城唯一命中：直接采纳第一条
          const distinctCities = new Set(candidates.map((c) => c.city).filter((c) => c.length > 0));
          if (distinctCities.size <= 1) {
            return {
              resolution: 'unique' as const,
              result: toResultPayload(candidates[0]),
            };
          }

          // 多城歧义：列出候选，由 Agent 反问
          const uniqueByCity = new Map<string, GeocodeCandidate>();
          for (const c of candidates) {
            if (!uniqueByCity.has(c.city)) uniqueByCity.set(c.city, c);
          }
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

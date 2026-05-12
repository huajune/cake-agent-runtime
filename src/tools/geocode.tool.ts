/**
 * 地理编码工具 — 将地名文本解析为标准化地址 + 经纬度
 *
 * Agent 在遇到不确定的地名（如 "九亭"、"陆家嘴"）时调用，
 * 返回标准化的省/市/区/镇层级结构和经纬度坐标。
 */

import { Logger } from '@nestjs/common';
import { tool } from 'ai';
import { z } from 'zod';
import { GeocodingService } from '@infra/geocoding/geocoding.service';
import { ToolBuilder } from '@shared-types/tool.types';
import { buildToolError, TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

const logger = new Logger('geocode');

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
- city 必须传；若系统已给出高置信城市，直接填入，不必为了 geocode 再做常识性追问
- city 信息来源优先级：[候选人当前明示城市] > [系统解析出的高置信城市] > [会话记忆]
- 只有拿不准城市、或当前地点线索与已知城市冲突时，才先向候选人确认，再调用本工具

## city 兜底红线（禁止猜测默认值）
- 候选人只给出「区/县/镇 + 通用后缀（商场/广场/购物中心/万象城/万达/天街等）」组合时，不能把区县名当作城市证据补 city，必须先反问候选人所在城市。
- 候选人提到的地名是带通用后缀的连锁地点（如 XX 名苑 / XX 商场 / XX 广场 / XX 天街 / XX 购物中心 / XX 步行街 / XX 大酒店 等，多个城市常有同名），且 [当前会话历史] [会话记忆] 全部没有明示城市时，**禁止默认任何"主力城市"作为 city 兜底**，必须先反问候选人所在城市。
- 反问话术参考："你这边主要在哪个城市呀？我帮你看下附近"——保持中性，不要带具体城市名。

## 边界
- 本轮高置信地点线索只用于帮助补 city 和理解意图，不替代 geocode
- 学校 / 校区 / 学院 / 小学部 / 附小 等地点名只是位置线索，不得据此推断候选人学历

## 空头承诺禁忌
- 未拿到经纬度前，不得说"我看了下附近 X 店"或复述历史门店事实；位置确认前只能说"我先帮你查一下附近的"`;

const inputSchema = z.object({
  address: z.string().describe('地名或地址文本（如 "九亭"、"人民广场"、"浦东新区张江"）'),
  city: z.string().describe('城市名（如 "上海"、"北京"），必填'),
});

export function buildGeocodeTool(geocodingService: GeocodingService): ToolBuilder {
  return () => {
    return tool({
      description: DESCRIPTION,
      inputSchema,
      execute: async ({ address, city }) => {
        const normalizedCity = city?.trim() ?? '';
        if (!normalizedCity) {
          return buildToolError({
            errorType: TOOL_ERROR_TYPES.GEOCODE_CITY_REQUIRED,
            replyInstruction:
              'city 是必填参数。优先用 [会话记忆] / [历史对话] 中候选人明示的城市；' +
              '若候选人只给出区县/镇 + 商场/广场/购物中心等通用地名，不得基于通识补 city；' +
              '地点存在歧义或无法确认唯一指向时，反问候选人所在城市，反问必须中性，不得带具体城市名。',
          });
        }

        try {
          const result = await geocodingService.geocode(address, normalizedCity);

          if (!result) {
            return buildToolError({
              errorType: TOOL_ERROR_TYPES.GEOCODE_UNRESOLVED_ADDRESS,
              replyInstruction:
                '地名无法在当前城市内解析。先核对 address 与 city 是否对应；' +
                '若候选人原话本就模糊（如只给出小区/楼栋俗称），向候选人确认更具体的地址或地标，' +
                '再重新调用本工具；不要凭已有信息硬猜地点。',
              details: { address, city: normalizedCity },
            });
          }

          return {
            formattedAddress: result.formattedAddress,
            province: result.province,
            city: result.city,
            district: result.district,
            township: result.township,
            longitude: result.longitude,
            latitude: result.latitude,
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

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

## 作用
1. 补全行政区划：将模糊地名解析为完整的省/市/区/街道，用返回的 district 作为 duliday_job_list.regionNameList
2. 获取经纬度：用返回的 latitude/longitude 组装 duliday_job_list.location；需要按 10km / 5km 等范围筛选时，把米数写入 location.range

## 参数
- city 必须传；若系统已给出高置信城市，直接填入，不必为了 geocode 再做常识性追问
- city 信息来源优先级：[候选人当前明示城市] > [系统解析出的高置信城市] > [会话记忆]
- 只有拿不准城市、或当前地点线索与已知城市冲突时，才先向候选人确认，再调用本工具

## 边界
- 本轮高置信地点线索只用于帮助补 city 和理解意图，不替代 geocode`;

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
        try {
          const result = await geocodingService.geocode(address, city);

          if (!result) {
            return { error: `无法解析地名: "${address}"` };
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
          return { error: `地理编码失败: ${err instanceof Error ? err.message : '未知错误'}` };
        }
      },
    });
  };
}

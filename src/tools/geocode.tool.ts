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
当候选人提到一个地名但你不确定它属于哪个城市或区域时，使用此工具解析。
例如："九亭" → 上海市松江区九亭镇 (121.32, 31.11)`;

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

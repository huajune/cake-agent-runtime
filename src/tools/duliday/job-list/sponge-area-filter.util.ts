/**
 * 海绵行政区适配（方案 §11.2，Phase 3 自 duliday-job-list.tool.ts 抽取归位）。
 *
 * 海绵按"地级 city + 县级 region"分层存储（实证：延吉市→延边朝鲜族自治州、
 * 昆山市→苏州市），候选人却常把县级市直接称作"城市"。本 util 承担供应商口径
 * 转换与串城防护，行政区层级知识一律经 @resolution/geo 的 resolver 查询，
 * 岗位工具不再 import 任何行政区映射常量。
 *
 * 海绵非标准命名如出现，维护在本 util 的本地 override，不进 geo（§11.2）。
 */

import { resolveParentAdministrativeArea } from '@resolution/geo';

export interface SpongeCityFilterNormalization {
  cityNameList: string[];
  derivedRegionNameList: string[];
  mappings: Array<{ requestedCity: string; spongeCity: string; spongeRegion: string }>;
}

/**
 * 把明确的县级市工具参数转换为海绵的“地级 city + 县级 region”口径。
 *
 * 结构化 cityNameList 参数语义明确，允许兼容裸名称（"延吉"→"延吉市"）；
 * 自由文本扫描仍只命中显式后缀（见 @resolution/geo resolver 注释）。
 * 未收录的城市原样透传，不猜父级。
 */
export function normalizeSpongeCityFilters(cityNames: string[]): SpongeCityFilterNormalization {
  const cityNameList: string[] = [];
  const derivedRegionNameList: string[] = [];
  const mappings: SpongeCityFilterNormalization['mappings'] = [];

  for (const requestedCity of cityNames) {
    const parent = resolveParentAdministrativeArea(requestedCity);
    if (!parent) {
      cityNameList.push(requestedCity);
      continue;
    }
    cityNameList.push(parent.parentCity);
    derivedRegionNameList.push(parent.canonicalName);
    mappings.push({
      requestedCity,
      spongeCity: parent.parentCity,
      spongeRegion: parent.canonicalName,
    });
  }

  return {
    cityNameList: [...new Set(cityNameList)],
    derivedRegionNameList: [...new Set(derivedRegionNameList)],
    mappings,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 海绵的 city/region 按地级/县级行政区分层；候选人却常把县级市直接称作“城市”。
 * 这里只剥最末级的通用后缀，用于判断 location-only 召回是否仍属于用户点名的行政区，
 * 不用于改写实际查询参数。
 */
function normalizeAdministrativeMatchKey(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/\s+/g, '')
    .replace(/[市区县旗]$/, '');
}

/**
 * 经纬度兜底（location-only 恢复查询）后的串城防护：只采纳
 * storeCityName/storeRegionName 仍能匹配原请求行政区的岗位，
 * 防止边界坐标把邻市岗位带回来（§11.2 约束 2/3）。
 */
export function filterJobsToRequestedAdministrativeArea<T>(
  jobs: T[],
  requestedCities: string[],
): T[] {
  const requestedKeys = new Set(
    requestedCities.map(normalizeAdministrativeMatchKey).filter(Boolean),
  );
  if (requestedKeys.size === 0) return [];

  return jobs.filter((job) => {
    if (!isRecord(job) || !isRecord(job.basicInfo)) return false;
    const storeInfo = job.basicInfo.storeInfo;
    if (!isRecord(storeInfo)) return false;
    return [storeInfo.storeCityName, storeInfo.storeRegionName].some((label) =>
      requestedKeys.has(normalizeAdministrativeMatchKey(label)),
    );
  });
}

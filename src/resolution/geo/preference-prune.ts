import { resolveCityFromDistrict } from './administrative-area.resolver';
import { normalizeCityName } from './geo-name.normalizer';
import { resolveCityFromLocation } from './place-alias.resolver';

export interface GeoPreferencePruneResult {
  districts: string[];
  locations: string[];
  removedDistricts: string[];
  removedLocations: string[];
}

/**
 * 会话城市确立后剔除跨城的区域/地点偏好。
 *
 * district/location 跨轮累积（D2），候选人换城（geocode 确权、明说新城市）时旧城的
 * 区/商圈会留在偏好里：09-11 核对近 7 天 16 个会话 city=北京 却带 district=江宁 /
 * 常州钟楼 / 顺德。只剔白名单能反推出城市且与会话城市不同的值；白名单外（反推不出
 * 城市）的值保持不动，不由代码猜它属于哪座城。city 为空时不剔任何值。
 */
export function pruneGeoPreferencesForCity(
  city: string | null | undefined,
  districts: readonly string[] | null | undefined,
  locations: readonly string[] | null | undefined,
): GeoPreferencePruneResult {
  const normalizedCity = normalizeCityName(city);
  const keptDistricts: string[] = [];
  const keptLocations: string[] = [];
  const removedDistricts: string[] = [];
  const removedLocations: string[] = [];

  for (const district of districts ?? []) {
    const resolved = normalizeCityName(resolveCityFromDistrict(district));
    if (normalizedCity && resolved && resolved !== normalizedCity) removedDistricts.push(district);
    else keptDistricts.push(district);
  }
  for (const location of locations ?? []) {
    const resolved = normalizeCityName(resolveCityFromLocation(location));
    if (normalizedCity && resolved && resolved !== normalizedCity) removedLocations.push(location);
    else keptLocations.push(location);
  }

  return { districts: keptDistricts, locations: keptLocations, removedDistricts, removedLocations };
}

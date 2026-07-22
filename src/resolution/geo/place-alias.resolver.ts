/**
 * 地标/商圈别名解析（自 memory/facts/geo-mappings.ts 行为等价迁移，Phase 1）。
 */

import { LOCATION_TO_CITY } from './place-alias.data';

/** 单个 location/商圈名 → 城市（命中白名单则返回 city，否则 null）。 */
export function resolveCityFromLocation(candidate: string): string | null {
  const normalized = candidate.replace(/\s+/g, '');
  return LOCATION_TO_CITY[candidate] ?? LOCATION_TO_CITY[normalized] ?? null;
}

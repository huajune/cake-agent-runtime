/**
 * 城市/区县名称归一化（自 memory/facts/geo-mappings.ts 行为等价迁移，Phase 1）。
 */

/**
 * 归一化后可去掉的后缀（"区/县/镇"等）。
 * 调用方在查找区县白名单前会用这个规则再试一次。
 */
export function normalizeDistrictForLookup(district: string): string {
  if (district.endsWith('开发区') || district.endsWith('新区')) return district;
  if (district.endsWith('街道')) return district.replace(/街道$/, '');
  return district.replace(/[区县镇乡]$/, '');
}

/** 把城市名归一化（去掉"市"后缀）。 */
export function normalizeCityName(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/市$/, '');
  return normalized || null;
}

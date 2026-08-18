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

/**
 * 把行政区比较值归一化：剥离末尾“市/省”并去空白。
 * D3 裁决：运营手打群标签与候选人城市共用这一口径；展示值仍由上游保留。
 *
 * 剥离以余下 ≥2 字为限（PR #1000 评审 P2-8）：无界循环会把「津市市」剥成
 * 单字「津」（县级市「津市」不可识别）、「芒市」剥成「芒」。省级折叠
 * （吉林省→吉林）维持现口径，与 D3 裁决对齐后再动。
 */
export function normalizeCityName(value: string | null | undefined): string | null {
  if (!value) return null;
  let normalized = value.trim();
  while (
    (normalized.endsWith('市') || normalized.endsWith('省')) &&
    normalized.slice(0, -1).trim().length >= 2
  ) {
    normalized = normalized.slice(0, -1).trim();
  }
  return normalized || null;
}

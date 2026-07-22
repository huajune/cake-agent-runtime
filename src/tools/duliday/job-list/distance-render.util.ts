/**
 * 距离渲染的锚点精度口径（方案 11.3，工作流 B-1）。
 *
 * 候选人只报区/市名时，geocode 锚点是行政区代表点（areaLevelQuery=true），
 * 按它算出的门店距离与候选人真实位置可能相差数公里。模型会高保真照抄工具
 * 文本，所以把"估算"口径直接渲染进所有距离文案，而不是指望模型自己改写
 * （district_level_distance_claim 44 条/2 天的拦截源头）。
 */

/** 本轮岗位查询距离锚点的精度判定结果。 */
export interface DistanceAnchorPrecision {
  /** area_level = 行政区代表点（区/市级锚点）；poi = 精确点位（POI/位置分享）。 */
  precision: 'poi' | 'area_level';
  /** 区级锚点的行政区名（如"海淀区"），用于"按 XX 估算"文案；poi 时为 null。 */
  areaName: string | null;
}

/**
 * 渲染距离文本：精确锚点 → "3.2km"；区级锚点 → "约3.2km（按海淀区估算）"。
 * 所有 candidate-facing 距离渲染点（推荐卡片/基本信息/摘要行/brandNearestStores）
 * 必须统一走本函数，保证估算口径不因渲染路径不同而漏标。
 */
export function formatDistanceKm(
  distanceKm: number,
  anchor?: DistanceAnchorPrecision | null,
): string {
  const base = `${distanceKm.toFixed(1)}km`;
  if (anchor?.precision !== 'area_level') return base;
  const areaLabel = anchor.areaName?.trim() || '区域中心';
  return `约${base}（按${areaLabel}估算）`;
}

/**
 * 区级锚点下插在岗位 markdown 结果头部的定位精度声明。
 * 精确锚点返回 null（不渲染）。
 */
export function buildDistancePrecisionNotice(
  anchor: DistanceAnchorPrecision | null | undefined,
): string | null {
  if (anchor?.precision !== 'area_level') return null;
  const areaLabel = anchor.areaName?.trim() || '行政区';
  return (
    `> ⚠️ **定位精度：区级代表点（${areaLabel}）**。本次坐标来自行政区级地名的 geocode，` +
    '不是候选人的精确位置，以下所有距离均为按该行政区代表点的**估算值**。' +
    '向候选人表述距离时必须沿用"约 X.Xkm（按 XX 估算）"的口径，' +
    '或先追问候选人具体位置/商圈/请对方发定位后重查；**严禁**把估算距离说成精确距离。\n\n'
  );
}

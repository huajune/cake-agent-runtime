export interface GeoPreferenceClearDecision {
  district: boolean;
  location: boolean;
}

/**
 * D2：district/location 跨轮默认累积；只有候选人明确表达“不按该维度限制”才清除。
 * “不考虑浦东”是排除某一区域，不等价于清空位置偏好，刻意不命中。
 */
export function decideGeoPreferenceClear(
  text: string | null | undefined,
): GeoPreferenceClearDecision {
  const value = text?.trim() ?? '';
  const district =
    /(?:地区|区域|区县|行政区)(?:也|都|全部)?(?:不限|无所谓|都可以|均可|不用限制)|不限(?:地区|区域|区县|行政区)/u.test(
      value,
    );
  const location =
    /(?:位置|地点|距离|远近)(?:也|都|全部)?(?:不限|无所谓|都可以|均可|不用限制)|不限(?:位置|地点|距离|远近)|不用按(?:位置|地点|距离)筛/u.test(
      value,
    );
  return { district, location };
}

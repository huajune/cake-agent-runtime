/** 地理编码结果 */
export interface GeocodeResult {
  /** 完整格式化地址 */
  formattedAddress: string;
  /** 省份 */
  province: string;
  /** 城市 */
  city: string;
  /** 区/县 */
  district: string;
  /** 街道/镇 */
  township: string;
  /** 经度 */
  longitude: number;
  /** 纬度 */
  latitude: number;
}

/**
 * 地理编码候选项（用于 `searchCandidates` 多候选返回）。
 *
 * 与 `GeocodeResult` 相比，额外携带 `poiName`，便于上层在歧义反问时
 * 给候选人列出"A 还是 B"——同名 POI 必须靠完整路径区分。
 */
export interface GeocodeCandidate extends GeocodeResult {
  /** POI 原始名称（如"马陆地铁站"）；结构化兜底分支没有 POI 名时为空字符串 */
  poiName: string;
  /**
   * 高德 POI 分类编码（typecode）。用于候选收敛时按精度择优：
   * - `1505*` 地铁站：坐标即站点真实位置，是最佳锚点
   * - `1903*` 交通地名（道路名/路口）：长路只返回一个代表点，精度最低、易锚偏
   * 结构化兜底分支无 POI 分类时为空字符串。
   */
  typecode: string;
}

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

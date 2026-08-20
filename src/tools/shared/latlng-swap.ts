/**
 * 经纬度对调确定性纠偏：检测模型把 latitude / longitude 两个数值填反的入参并交换回来。
 *
 * 背景（badcase chat 6a86a508ce406a6aee79814c，7 天内同型 4 例、结果全为 empty）：
 * 模型从 geocode 结果转抄坐标进 duliday_job_list.location 时发生位置转写错误——
 * 同一响应里 reasoning 写的绑定是对的（"location: {longitude: 121.27, latitude: 31.38}"），
 * 发射的 tool call JSON 却把两个值对调。搜索圆心落到纬度 121° 的无效点，距离召回
 * 必然 0 条 → 假"无岗"话术 + 拉群收口（嘉定 4.5km 处实有在招岗）。
 * 教导 prompt 防不住这种错误（模型的计划本来就是对的），只能在工具入参处确定性纠偏。
 *
 * 判据：业务只在中国大陆展业，纬度 ∈ [3, 54]、经度 ∈ [73, 135]，两区间不重叠，
 * 因此「纬度落在经度区间 且 经度落在纬度区间」是无歧义的对调信号。该判据同时
 * 覆盖经度 < 90 的西部城市（如乌鲁木齐 lng≈87：对调后 lat=87 仍 ≤90，
 * 单靠 |lat|>90 的物理判据测不出来）。不构成交叉形态的异常坐标（如境外坐标、
 * 单边越界）不做任何猜测性修改，原样透传。
 */

/** 中国大陆业务坐标范围（度）。 */
const CHINA_LAT_MIN = 3;
const CHINA_LAT_MAX = 54;
const CHINA_LNG_MIN = 73;
const CHINA_LNG_MAX = 135;

const inChinaLatRange = (value: number): boolean =>
  value >= CHINA_LAT_MIN && value <= CHINA_LAT_MAX;
const inChinaLngRange = (value: number): boolean =>
  value >= CHINA_LNG_MIN && value <= CHINA_LNG_MAX;

export interface LatLngSwapResult {
  latitude: number;
  longitude: number;
  /** true = 检测到对调并已交换；false = 原样透传（含无法判定的异常坐标）。 */
  swapped: boolean;
}

/** 检测经纬度对调并纠正；仅在交叉形态（无歧义对调）时交换，其余原样返回。 */
export function correctSwappedLatLng(latitude: number, longitude: number): LatLngSwapResult {
  if (inChinaLngRange(latitude) && inChinaLatRange(longitude)) {
    return { latitude: longitude, longitude: latitude, swapped: true };
  }
  return { latitude, longitude, swapped: false };
}

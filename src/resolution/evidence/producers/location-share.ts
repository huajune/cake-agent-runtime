import { parseLocationShareCoordinates } from '@resolution/signal/markers';

/**
 * 定位分享消息的坐标解析（候选人资料证据化共享工具）。
 *
 * 渲染约定见 MessageParser：`[位置分享] {title} [经纬度:lat,lng]`。
 * 两个消费方：
 * - extractFacts（A2）：轮末逆解析城市入档 pref.city；
 * - preparation（轮内锚点）：turn 开始逆解析 seed 进 ledger.geocodeAnchors，
 *   让同轮的 invite 城市门 / job_list 距离口径直接可用（badcase 6a6846e2：
 *   定位分享轮内 job_list 直接吃坐标、未调 geocode，invite 四档出处全空被拒）。
 */

export interface LocationShareCoords {
  latitude: number;
  longitude: number;
}

/**
 * 从候选人消息里解析定位分享坐标；多条取最后一条（最新位置）。
 *
 * 引用块先剥离——转发的经理定位不算候选人自己的位置；
 * 必须带 `[位置分享]` 标记，防止把岗位地址里的坐标残片误当候选人位置。
 */
export function parseLocationShareCoords(texts: readonly string[]): LocationShareCoords | null {
  return parseLocationShareCoordinates(texts);
}

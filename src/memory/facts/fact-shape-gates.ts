/**
 * 会话事实写入侧的确定性形状门（badcase 6a6c4c13，2026-07-31）。
 *
 * 该案候选人只说了"boss/做兼职/在长安/晚上才可以，有吗？"，一次抽取把整句
 * "晚上才可以，有吗？"同时写进 pref.city（还被归一化抬成 confidence=high/
 * evidence=explicit_city）、pref.salary、interview.age——标量扇出污染
 * （2026-08-03 抽样 12% 会话中招）。高置信垃圾城市还会压制后续确认问答裁决，
 * 让真实城市写不进去。
 *
 * 两类门都是纯函数，由 session.service extractFacts 的字段门族调用：
 * - 扇出熔断：同一非空字符串同轮写进 ≥3 个字段 → 该值所有字段整组丢弃；
 * - 形状门：city/age 的值必须长得像城市/年龄，否则字段级丢弃。
 */

import { isRecognizedCityName } from '@resolution/geo';

/** 同一字符串值命中 ≥N 个字段视为扇出广播（判据来自污染实测：name=age=gender 同值）。 */
export const SCALAR_FANOUT_FIELD_THRESHOLD = 3;

/**
 * 检出被扇出广播的字符串值。
 *
 * 输入是"字段名 → 已解包值"的平面映射；仅统计 trim 后长度 ≥2 的字符串
 * （布尔/数字/数组不参与——它们的重复是正常业务形态，如多字段 false）。
 */
export function detectScalarFanoutValues(fields: Record<string, unknown>): Set<string> {
  const counts = new Map<string, number>();
  for (const value of Object.values(fields)) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length < 2) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  const fanout = new Set<string>();
  for (const [value, count] of counts) {
    if (count >= SCALAR_FANOUT_FIELD_THRESHOLD) fanout.add(value);
  }
  return fanout;
}

/**
 * 城市值门：值必须能被行政区数据认领，否则字段级丢弃。
 *
 * 2026-08-06 生产观测推翻了原先"8 字内自由放行"的写法——该放行口对当期观测到的
 * 11 个垃圾城市只拦住 3 个（`00:30`/整句/带疑问尾词的），`hello`、`null`、
 * `只晚班`、`我是应聘的`、`平坊` 这些短串全部直通。短串靠形状分辨不出真假城市，
 * 判据只能是数据表认领（同一批值喂给行政区表：垃圾全否、真城市全是，含海南东方市）。
 */
export function isPlausibleCityValue(value: string): boolean {
  return isRecognizedCityName(value);
}

/** 年龄值形状门：必须能解析出 14-70 的单一数字（"39"/"39岁"合法，区间与整句不合法）。 */
export function isPlausibleAgeValue(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 14 && value <= 70;
  }
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 6) return false;
  const matches = trimmed.match(/\d{1,3}/g);
  if (!matches || matches.length !== 1) return false;
  const age = Number(matches[0]);
  return age >= 14 && age <= 70;
}

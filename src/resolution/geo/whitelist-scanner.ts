/**
 * “白名单驱动 + 最长优先”扫描原语。
 *
 * 这是地理识别的核心机制——把"贪婪正则吞整段 → 事后清洗"反过来：
 * 先用白名单做最长精确匹配（数据驱动，扩白名单即扩能力），未覆盖的字符段交给
 * 正则兜底（识别白名单外的"XX区/镇/街道"，但不补 city，留给 LLM 处理）。
 */

import type { WhitelistScanHit, WhitelistScanResult } from './geo.types';

/**
 * 地名通名后缀：地名裸词后紧跟这些字样时，命中的是"路/街/公园"等**其他地物**的
 * 专名部分，而不是行政区本身，必须拒绝。
 *
 * 例如「宝安公路」、「宝山中街」和「洪湖公园」中的区县名只是其它地物专名的一部分。
 * 合法区名不能逐个从白名单删除，因此必须在匹配层统一拒绝这类通名后缀。
 *
 * 刻意**不含** 区/县/市/镇/街道/新区/开发区——那些后缀恰恰是"确实是行政区"的证据。
 * `街(?!道)` 保证 "青浦街道" 不被误拒；同理 "大道" 拒、"街道" 放行。
 */
const PLACE_FEATURE_SUFFIX_PATTERN =
  /^(?:公路|公园|广场|花园|小区|大厦|新村|大道|[东西南北中]?(?:路|街(?!道)|巷|弄|桥))/;

/** 通名探测最多向后看的字符数（"公路"/"中街" 均 ≤2，留 1 字余量）。 */
const SUFFIX_LOOKAHEAD = 3;

/**
 * 给定消息与字典，按 key 长度降序找出所有非重叠命中。
 *
 * 设计要点：
 * - 按 key 长度降序遍历，确保 "浦东新区" 先于 "浦东" 被消费，不会被 "浦东" 提前占用
 * - 通过 `preCovered` 串联多轮扫描（city → district → location），后续轮次不会
 *   再去吃前面已认领的字符段，天然避免歧义
 * - hits 按 start 升序返回，方便上游"开头紧凑表达"的判定
 * - `rejectPlaceFeatureSuffix` 开启后，命中若被通名跟随则整条丢弃且**不标记 covered**，
 *   把字符段留给后续字典轮次与 raw district 正则兜底
 */
export function scanWhitelistKeysByLongest(
  message: string,
  dict: Readonly<Record<string, unknown>>,
  preCovered?: readonly boolean[],
  options?: { rejectPlaceFeatureSuffix?: boolean },
): WhitelistScanResult {
  const len = message.length;
  const covered: boolean[] = preCovered
    ? Array.from({ length: len }, (_, i) => preCovered[i] ?? false)
    : new Array(len).fill(false);

  const hits: WhitelistScanHit[] = [];
  const sortedKeys = Object.keys(dict)
    .filter((key) => key.length > 0 && key.length <= len)
    .sort((a, b) => b.length - a.length);

  for (const key of sortedKeys) {
    let from = 0;
    while (from <= len - key.length) {
      const idx = message.indexOf(key, from);
      if (idx < 0) break;
      const end = idx + key.length;
      let collides = false;
      for (let i = idx; i < end; i++) {
        if (covered[i]) {
          collides = true;
          break;
        }
      }
      if (collides) {
        from = idx + 1;
        continue;
      }
      if (
        options?.rejectPlaceFeatureSuffix &&
        PLACE_FEATURE_SUFFIX_PATTERN.test(message.slice(end, end + SUFFIX_LOOKAHEAD))
      ) {
        // 通名跟随 → 命中的是路/街/公园专名，丢弃且不认领字符（留给后轮与正则兜底）
        from = idx + 1;
        continue;
      }
      hits.push({ key, start: idx, end });
      for (let i = idx; i < end; i++) covered[i] = true;
      from = end;
    }
  }

  hits.sort((a, b) => a.start - b.start);
  return { hits, covered };
}

/**
 * 在指定字符级覆盖之外的连续区间上跑一次正则匹配，用于"白名单兜底"。
 *
 * 调用者通常已经先跑完 city/district/location 三轮白名单扫描，未覆盖的字符段
 * 才是真正"白名单未识别"的部分；这里在这些段上跑 [一-龥]+(?:区|县|镇|街道|新区|开发区)
 * 之类的正则去捕获白名单外的 raw district——但仅作为 district 标注，不补 city。
 */
export function matchInUncoveredSegments(
  message: string,
  covered: readonly boolean[],
  pattern: RegExp,
): string[] {
  const segments: string[] = [];
  let buf = '';
  for (let i = 0; i < message.length; i++) {
    if (covered[i]) {
      if (buf) {
        segments.push(buf);
        buf = '';
      }
    } else {
      buf += message[i];
    }
  }
  if (buf) segments.push(buf);

  const matches: string[] = [];
  for (const segment of segments) {
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    const globalPattern = new RegExp(pattern.source, flags);
    for (const m of segment.matchAll(globalPattern)) {
      if (m[1] !== undefined) matches.push(m[1]);
      else if (m[0]) matches.push(m[0]);
    }
  }
  return matches;
}

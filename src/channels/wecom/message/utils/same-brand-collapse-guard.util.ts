/**
 * 同品牌多门店"被压缩成一句"的输出兜底检测。
 *
 * 业务背景：badcase `laybqxn4` —— 用户位置分享后，Agent 推荐两家肯德基门店，
 * 但回复写成"有肯德基，17-27.5 元、肯德基，17-27.5 元可以选"，把两家门店压
 * 成相同的两次品牌名，候选人无法区分。job-list 工具已给 LLM 注入了 displayLine
 * 强约束（带 storeName/distance），但模型仍可能违反；这里在投递层做最后一道
 * 兜底——发现"同名 3+ 字中文片段在近距离内重复且中间没有任何门店/区域标记"
 * 时静默丢弃，与 output-leak-guard 同策略。
 *
 * 检测原则：
 * - 仅扫 3-6 字的纯汉字片段（覆盖几乎所有常见品牌名："肯德基"/"必胜客"/
 *   "奥乐齐"/"成都你六姐"/"麦当劳"/"M Stand" 含字母不参与本规则）
 * - 重复必须发生在 30 字以内，再远不视为"被压缩"
 * - 若两次出现之间含任意门店/区域标记字（店/家/路/号/街/区/广场/中心/枢纽
 *   /城/巷/弄/方向/带），认为已经分清，不算违规
 */

const STORE_OR_AREA_MARKER = /[店家路号街区广场中心枢纽城巷弄方向带]/;
// 第二次出现的"分隔符前缀"——只有当重复出现在列表式语境（、/，/。/或/还）时才
// 视为"被压缩"。否则像"...店时薪 24 元，肯德基徐汇日月光店时薪 26 元"中
// "店时薪"的内部重复会误伤。
const LIST_SEPARATOR_BEFORE_REPEAT = /[、，,；;。．.\s或还]$/;
const REPEAT_SCAN_RANGE = 30;
const HAN_ONLY = /^[一-鿿]+$/u;

export function findCollapsedSameBrand(content: string): string | null {
  if (!content) return null;
  // 优先匹配较长片段（避免短的子串先于完整品牌名命中）
  for (let len = 6; len >= 3; len--) {
    for (let i = 0; i + len <= content.length; i++) {
      const candidate = content.slice(i, i + len);
      if (!HAN_ONLY.test(candidate)) continue;
      const tailStart = i + len;
      const tail = content.slice(tailStart, tailStart + REPEAT_SCAN_RANGE + len);
      const next = tail.indexOf(candidate);
      if (next === -1) continue;
      const between = tail.slice(0, next);
      // 中间夹了门店/区域标记 → 已经分清，跳过
      if (STORE_OR_AREA_MARKER.test(between)) continue;
      // 第二次出现前必须是列表分隔符（、/，/。/空格/或/还），否则属于片段巧合重复
      if (between.length === 0 || !LIST_SEPARATOR_BEFORE_REPEAT.test(between)) continue;
      return candidate;
    }
  }
  return null;
}

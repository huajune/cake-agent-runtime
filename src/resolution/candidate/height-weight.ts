import type { CandidateParseResult } from './types';

const REQUIREMENT_CONTEXT_RE =
  /(?:要求|需要|限|须|不低于|不高于|至少|最低|最高|以上|以下|能做吗|可以吗)/u;

/**
 * 身高/体重自报解析。
 *
 * PR #1000 评审 P2-2 的两处修正：
 * - 数值后允许「左右/上下/多」类模糊尾缀（「170左右」「60多」develop 两轨都能抓）；
 * - 要求语境按**每次出现**的局部窗口判定，不再只看首次出现——混合句
 *   「岗位身高要求165以上，我身高170」里第二次自报不应被首个要求语境整条压制。
 */
function parseBodyMetric(
  text: string,
  marker: '身高' | '体重',
  unitPattern: string,
  min: number,
  max: number,
  normalize: (value: number, unit: string | undefined) => number = (value) => value,
): CandidateParseResult<number> | null {
  // 单位放在前瞻里捕获：excerpt 仍只到数字（"体重55"），但能知道候选人报的是 kg 还是斤。
  const pattern = new RegExp(
    `${marker}\\s*[：:]?\\s*(\\d{2,3})(?=\\s*(?:左右|上下|多)?\\s*(${unitPattern})?(?:$|[，,。;；！!\\s]))`,
    'giu',
  );
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    // 要求语境窗口不跨子句：混合句里相邻子句的「要求/以上」不该压制本子句的自报。
    const delimiters = [...'，,。;；！!？?\n\r'];
    const clauseStart = Math.max(
      0,
      ...delimiters.map((delim) => text.lastIndexOf(delim, index) + 1),
    );
    const clauseEndCandidates = delimiters
      .map((delim) => text.indexOf(delim, index))
      .filter((position) => position >= 0);
    const clauseEnd =
      clauseEndCandidates.length > 0 ? Math.min(...clauseEndCandidates) : text.length;
    const window = text.slice(
      Math.max(clauseStart, index - 8),
      Math.min(clauseEnd, index + marker.length + 24),
    );
    if (REQUIREMENT_CONTEXT_RE.test(window)) continue;
    const value = normalize(Number(match[1]), match[2]?.toLowerCase());
    if (value >= min && value <= max) {
      return { value, excerpt: match[0].trim() };
    }
  }
  return null;
}

/**
 * 体重口径：候选人口语里"体重 120"几乎总是斤（成年人 kg 极少 ≥100），落进 `体重(kg)`
 * 字段前必须换算；显式带 kg/公斤 的照收。生产 09-02 核对：会话里 31 条体重有 5 条 ≥120，
 * 长期档案 13 条有 4 条，全是斤当 kg。阈值与表单侧 canonicalizeCandidateFieldValue 共用。
 */
export const WEIGHT_JIN_THRESHOLD = 100;

export function normalizeWeightToKg(value: number, unit: string | undefined): number {
  if (unit === '斤' || (!unit && value >= WEIGHT_JIN_THRESHOLD)) return Math.round(value / 2);
  return value;
}

export function parseHeight(text: string): CandidateParseResult<number> | null {
  return parseBodyMetric(text, '身高', 'cm|厘米|公分', 100, 250);
}

export function parseWeight(text: string): CandidateParseResult<number> | null {
  return parseBodyMetric(text, '体重', 'kg|公斤|千克|斤', 30, 200, normalizeWeightToKg);
}

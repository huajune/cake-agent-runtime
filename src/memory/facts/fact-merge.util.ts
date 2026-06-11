/**
 * 事实合并共享原语。
 *
 * 收敛原本散落在 SessionService 上、与跨轮置信度守卫重复的两类判断：
 * - 「值相等判断」（isSameFactValue）；
 * - 「值是否有意义」（hasMeaningfulValue）。
 *
 * 同轮 rule×LLM 的统一字段合并（取代旧 [c] mergeHighConfidenceRuleFacts +
 * [d] applyHighConfidenceMetadata 的两次遍历）由 SessionService.mergeRuleFactsIntoLlm
 * 调用本文件的原语完成；跨轮置信度守卫（mergeFactsWithConfidenceGuard）也共用这些原语。
 */

/** 字段值是否「有意义」：null/undefined/空串/空数组 视为无值；boolean（含 false）有值。 */
export function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * 事实值相等判断。
 * - 数组：归一化（trim/去空/排序）后比较，顺序无关；
 * - 任一为字符串：按 trim 后字符串相等；
 * - 其余（对象/布尔/数字）：JSON 序列化比较。
 */
export function isSameFactValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    const normalize = (values: unknown[]) =>
      values
        .map((value) => String(value).trim())
        .filter(Boolean)
        .sort();
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
  }
  if (typeof left === 'string' || typeof right === 'string') {
    return String(left).trim() === String(right).trim();
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 累积去重合并两个可空字符串数组；结果为空时返回 null。 */
export function mergeNullableStringArrays(
  first: string[] | null | undefined,
  second: string[] | null | undefined,
): string[] | null {
  const merged = Array.from(new Set([...(first ?? []), ...(second ?? [])]));
  return merged.length > 0 ? merged : null;
}

/**
 * 某字段的最终值是否应采用 rule 的高置信元数据（high/rule）。
 *
 * 与旧 applyHighConfidenceField 的判定一致：rule 该字段有意义值，且
 * （当前合并值无意义 ⇒ rule 补位；或当前值与 rule 值相同 ⇒ 二者一致）。
 * 当前值有意义且与 rule 不同时（LLM 取胜且值不同），保留 LLM 元数据，返回 false。
 */
export function shouldAdoptRuleMeta(currentValue: unknown, ruleValue: unknown): boolean {
  if (!hasMeaningfulValue(ruleValue)) return false;
  if (!hasMeaningfulValue(currentValue)) return true;
  return isSameFactValue(currentValue, ruleValue);
}

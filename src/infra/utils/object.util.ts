/**
 * 对象工具函数
 */

/**
 * 递归清理对象中的空值字段：
 * - null / undefined 直接剔除
 * - 空字符串 '' 剔除
 * - 空数组 [] 剔除
 * - 空对象 {} 剔除（在递归清理后仍为空）
 *
 * 用于裁剪工具返回值，减少传给 LLM 的噪声。
 * 原始类型（number/boolean 包含 0 / false）一律保留。
 */
export function stripNullish<T>(value: T): T {
  if (Array.isArray(value)) {
    const cleanedArr = value.map((item) => stripNullish(item)).filter((item) => !isEmpty(item));
    return cleanedArr as unknown as T;
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, rawChild] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripNullish(rawChild);
      if (!isEmpty(cleaned)) {
        result[key] = cleaned;
      }
    }
    return result as unknown as T;
  }

  return value;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

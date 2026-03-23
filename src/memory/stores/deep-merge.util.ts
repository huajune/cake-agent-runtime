function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * 深度合并
 * - null / undefined / '' → 不覆盖旧值（"未提到" ≠ "主动否认"）
 * - 数组 → 累积去重
 * - 对象 → 递归合并
 * - 其他 → 新值覆盖
 */
export function deepMerge(prev: unknown, next: unknown): unknown {
  if (Array.isArray(prev) && Array.isArray(next)) {
    return Array.from(new Set([...prev, ...next]));
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const result: Record<string, unknown> = { ...prev };
    for (const key of Object.keys(next)) {
      result[key] = deepMerge(prev[key], next[key]);
    }
    return result;
  }
  return next !== undefined && next !== null && next !== '' ? next : prev;
}

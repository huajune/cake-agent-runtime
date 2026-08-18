/**
 * 对象工具函数
 */

/** 任意 JSON 对象的通用读取形态：键为字符串、值未收窄。 */
export type UnknownRecord = Record<string, unknown>;

/**
 * unknown 是否为「普通对象」——排除 null 与数组。
 *
 * 海绵接口返回、工具 payload、Redis 反序列化结果这类外部数据结构不受控，
 * 读字段前统一走这里收窄，避免对 null 取属性或把数组当对象读。
 */
export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `isRecord` 的取值版：是普通对象则原样返回，否则 null。 */
export function asRecord(value: unknown): UnknownRecord | null {
  return isRecord(value) ? value : null;
}

/** 数组元素逐个按 Record 收窄，非对象元素丢弃；非数组输入返回空数组。 */
export function asRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** 非数组输入统一降级成空数组，便于直接 map / for-of。 */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

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

/** 值是普通对象（非 null、非数组）时按 Record 读取，否则 undefined。 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

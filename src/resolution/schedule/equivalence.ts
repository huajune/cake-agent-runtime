import { readScheduleConditions, type StoredScheduleConstraint } from './types';

/**
 * 班次条件的有效等价形态：省略、null、false、空数组与 endDayOffset:0 都表示没有该项限制，
 * 数组去重排序、对象键排序。查询签名、查岗出处闸和轮末落盘共用同一口径。
 */
export function canonicalizeScheduleConstraint(
  constraint: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const canonical = canonicalizeScheduleValue(constraint ?? null);
  return canonical !== null && typeof canonical === 'object' && !Array.isArray(canonical)
    ? (canonical as Record<string, unknown>)
    : null;
}

/** 有效比较键：规范化后的条件与旧早晚班/旧时段待确认状态共同决定实际筛选行为。 */
export function effectiveScheduleKey(stored: StoredScheduleConstraint | null | undefined): string {
  const { conditions, legacyUnresolved } = readScheduleConditions(stored ?? {});
  return JSON.stringify({
    conditions: canonicalizeScheduleConstraint(conditions),
    legacyUnresolved,
  });
}

function canonicalizeScheduleValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = [...new Set(value)].sort();
    return items.length > 0 ? items : null;
  }
  if (value === null || typeof value !== 'object') return value === false ? null : value;
  const entries = Object.entries(value)
    .map(([key, item]) => [key, canonicalizeScheduleValue(item)] as const)
    .filter(([key, item]) => item != null && !(key === 'endDayOffset' && item === 0))
    .sort(([a], [b]) => a.localeCompare(b));
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

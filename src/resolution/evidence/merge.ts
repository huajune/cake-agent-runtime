/**
 * 事实合并共享原语。
 *
 * 收敛原本散落在 SessionService 上、与跨轮置信度守卫重复的两类判断：
 * - 「值相等判断」（isSameFactValue）；
 * - 「值是否有意义」（hasMeaningfulValue）。
 *
 * 同轮 rule×LLM 的统一字段合并由 SessionService.mergeRuleAndLlmFacts 调用本文件的
 * 原语单遍完成；跨轮置信度守卫（mergeFactsWithConfidenceGuard）也共用这些原语。
 */

import type { InterviewInfoFieldKey, PreferenceFieldKey } from '@memory/types/session-facts.types';

export type MergePolicy = 'scalar-first' | 'rule-overrides' | 'array-union' | 'custom' | 'retired';

/**
 * rule × LLM 合并策略的唯一字段表。新增 schema 字段不在这里表态会编译失败。
 * brand_state 已接管 brands；brand_ids 是独立数组，不能再被静默丢弃。
 */
export const FIELD_MERGE_POLICIES = {
  name: 'scalar-first',
  phone: 'scalar-first',
  gender: 'custom',
  gender_source: 'custom',
  age: 'scalar-first',
  applied_store: 'scalar-first',
  applied_position: 'scalar-first',
  interview_time: 'scalar-first',
  is_student: 'scalar-first',
  education: 'scalar-first',
  has_health_certificate: 'rule-overrides',
  experience: 'scalar-first',
  upload_resume: 'scalar-first',
  height: 'scalar-first',
  weight: 'scalar-first',
  household_register_province: 'scalar-first',
  brands: 'retired',
  brand_ids: 'array-union',
  salary: 'scalar-first',
  position: 'array-union',
  schedule: 'scalar-first',
  city: 'custom',
  district: 'array-union',
  location: 'array-union',
  labor_form: 'scalar-first',
  delayed_intent: 'scalar-first',
  short_term: 'scalar-first',
  open_position: 'scalar-first',
  time_windows: 'array-union',
  schedule_constraint: 'custom',
  available_after: 'scalar-first',
} as const satisfies Record<InterviewInfoFieldKey | PreferenceFieldKey, MergePolicy>;

export function fieldsWithMergePolicy(
  group: 'interview_info' | 'preferences',
  policy: MergePolicy,
): string[] {
  const interviewFields = new Set<string>([
    'name',
    'phone',
    'gender',
    'gender_source',
    'age',
    'applied_store',
    'applied_position',
    'interview_time',
    'is_student',
    'education',
    'has_health_certificate',
    'experience',
    'upload_resume',
    'height',
    'weight',
    'household_register_province',
  ]);
  return Object.entries(FIELD_MERGE_POLICIES)
    .filter(
      ([field, value]) =>
        value === policy && (group === 'interview_info') === interviewFields.has(field),
    )
    .map(([field]) => field);
}

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

export function mergeNullableArrays<T>(
  current: T[] | null | undefined,
  incoming: T[] | null | undefined,
): T[] | null {
  const merged = [...(current ?? []), ...(incoming ?? [])];
  return merged.length > 0 ? Array.from(new Set(merged)) : null;
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

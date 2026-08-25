/**
 * 事实合并共享原语。
 *
 * 收敛原本散落在 SessionStateService 上、与跨轮置信度守卫重复的两类判断：
 * - 「值相等判断」（isSameFactValue）；
 * - 「值是否有意义」（hasMeaningfulValue）。
 *
 * 同轮 rule×LLM 的统一字段合并由 SessionStateService.mergeRuleAndLlmFacts 调用本文件的
 * 原语单遍完成；跨轮置信度守卫（mergeFactsWithConfidenceGuard）也共用这些原语。
 */

import type { TurnHint, TurnHints, TurnHintConfidence, TurnHintFieldPath } from './claim.types';
import { TURN_HINT_FIELD_POLICIES } from './policies';
import type {
  TurnHintCity,
  TurnHintInterviewFieldKey,
  TurnHintPreferenceFieldKey,
  TurnHintProjection,
} from './types';

export type MergePolicy = 'scalar-first' | 'rule-overrides' | 'array-union' | 'custom' | 'retired';

/**
 * rule × LLM 合并策略的唯一字段表。新增 schema 字段不在这里表态会编译失败。
 * facts.brand 已接管 brands；brand_ids 是独立数组，不能再被静默丢弃。
 */
export const FIELD_MERGE_POLICIES = {
  name: 'scalar-first',
  phone: 'scalar-first',
  gender: 'custom',
  gender_source: 'custom',
  age: 'scalar-first',
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
} as const satisfies Record<TurnHintInterviewFieldKey | TurnHintPreferenceFieldKey, MergePolicy>;

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
 * 与退役前的本轮提示合并判定一致：rule 该字段有意义值，且
 * （当前合并值无意义 ⇒ rule 补位；或当前值与 rule 值相同 ⇒ 二者一致）。
 * 当前值有意义且与 rule 不同时（LLM 取胜且值不同），保留 LLM 元数据，返回 false。
 */
export function shouldAdoptRuleMeta(currentValue: unknown, ruleValue: unknown): boolean {
  if (!hasMeaningfulValue(ruleValue)) return false;
  if (!hasMeaningfulValue(currentValue)) return true;
  return isSameFactValue(currentValue, ruleValue);
}

const TURN_HINT_CONFIDENCE_RANK: Record<TurnHintConfidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export interface ResolvedTurnHint {
  field: TurnHintFieldPath;
  value: unknown;
  confidence: TurnHintConfidence;
  producer: TurnHint['producer'];
  evidence: TurnHint['evidence'];
  assertedAt: string;
}

export interface ResolveTurnHintOptions {
  minConfidence?: TurnHintConfidence;
}

/** 同一条 claim 流按字段策略表裁决；producer 不持有 first/last/union/composite 逻辑。 */
export function resolveTurnHints(
  input: TurnHints | null | undefined,
  options: ResolveTurnHintOptions = {},
): ResolvedTurnHint[] {
  if (!input) return [];
  const minRank = TURN_HINT_CONFIDENCE_RANK[options.minConfidence ?? 'low'];
  const byField = new Map<TurnHintFieldPath, TurnHint[]>();
  for (const claim of input.claims) {
    if (TURN_HINT_CONFIDENCE_RANK[claim.confidence] < minRank) continue;
    const policy = TURN_HINT_FIELD_POLICIES[claim.field];
    const allowedOperations: readonly ('set' | 'clear')[] = policy.allowedOperations;
    if (!allowedOperations.includes(claim.operation)) continue;
    const list = byField.get(claim.field) ?? [];
    list.push(claim);
    byField.set(claim.field, list);
  }

  const resolved: ResolvedTurnHint[] = [];
  for (const field of Object.keys(TURN_HINT_FIELD_POLICIES) as TurnHintFieldPath[]) {
    const claims = byField.get(field);
    if (!claims?.length) continue;
    const policy = TURN_HINT_FIELD_POLICIES[field];
    let selected: TurnHint | undefined;
    let value: unknown;

    if (policy.selection === 'first-scalar') {
      selected = claims.find(
        (claim) => claim.operation === 'set' && hasMeaningfulValue(claim.value),
      );
      value = selected?.value;
    } else if (policy.selection === 'last-scalar') {
      for (const claim of claims) {
        if (claim.operation === 'set' && hasMeaningfulValue(claim.value)) {
          selected = claim;
          value = claim.value;
          continue;
        }
        if (claim.operation !== 'clear' || selected === undefined) continue;
        const clearedValues = claim.clearValues ?? [];
        if (
          clearedValues.length === 0 ||
          clearedValues.some((item) => isSameFactValue(item, value))
        ) {
          selected = undefined;
          value = undefined;
        }
      }
    } else if (policy.selection === 'union-array') {
      const union: unknown[] = [];
      for (const claim of claims) {
        if (claim.operation === 'clear') {
          union.splice(0, union.length);
          selected = claim;
          continue;
        }
        if (!Array.isArray(claim.value)) continue;
        selected = claim;
        for (const item of claim.value) {
          if (!union.some((existing) => isSameFactValue(existing, item))) union.push(item);
        }
      }
      value = union.length > 0 ? union : undefined;
    } else {
      const composite: Record<string, unknown> = { ...(policy.defaults ?? {}) };
      for (const claim of claims) {
        if (claim.operation === 'clear') {
          for (const key of Object.keys(composite)) delete composite[key];
          selected = claim;
          continue;
        }
        if (!claim.value || typeof claim.value !== 'object' || Array.isArray(claim.value)) continue;
        selected = claim;
        for (const [key, item] of Object.entries(claim.value)) {
          if (item !== null && item !== undefined) composite[key] = item;
        }
      }
      value = selected ? composite : undefined;
    }

    if (!selected || !hasMeaningfulValue(value)) continue;
    resolved.push({
      field,
      value,
      confidence: selected.confidence,
      producer: selected.producer,
      evidence: selected.evidence,
      assertedAt: selected.assertedAt,
    });
  }
  return resolved;
}

export function getTurnHint(
  input: TurnHints | null | undefined,
  field: TurnHintFieldPath,
  options: ResolveTurnHintOptions = {},
): ResolvedTurnHint | null {
  return resolveTurnHints(input, options).find((fact) => fact.field === field) ?? null;
}

export function getTurnHintValue<T>(
  input: TurnHints | null | undefined,
  field: TurnHintFieldPath,
  options: ResolveTurnHintOptions = {},
): T | null {
  return (getTurnHint(input, field, options)?.value as T | undefined) ?? null;
}

/** resolution 本地的消费视图骨架；不在证据域反向加载 memory 存储实例。 */
function createEmptyTurnHintProjection(reasoning: string): TurnHintProjection {
  return {
    interview_info: {
      name: null,
      phone: null,
      gender: null,
      gender_source: null,
      age: null,
      is_student: null,
      education: null,
      has_health_certificate: null,
      experience: null,
      upload_resume: null,
      height: null,
      weight: null,
      household_register_province: null,
    },
    preferences: {
      brands: null,
      brand_ids: null,
      salary: null,
      position: null,
      schedule: null,
      city: null,
      district: null,
      location: null,
      labor_form: null,
      delayed_intent: null,
      short_term: null,
      open_position: null,
      time_windows: null,
      schedule_constraint: null,
      available_after: null,
    },
    reasoning,
  };
}

/** claim 裁决结果投影为既有运行时/存储 schema；投影不再携带第二套治理语义。 */
export function projectTurnHints(
  input: TurnHints | null | undefined,
  options: ResolveTurnHintOptions = {},
): TurnHintProjection | null {
  const resolved = resolveTurnHints(input, options);
  if (resolved.length === 0) return null;
  const projected = createEmptyTurnHintProjection(input?.reasoning ?? '规则 claim 投影');
  for (const fact of resolved) {
    const [group, field] = fact.field.split('.') as ['interview_info' | 'preferences', string];
    const value =
      fact.field === 'preferences.city'
        ? {
            value: String(fact.value),
            confidence: fact.confidence === 'high' ? 'high' : 'medium',
            evidence: normalizeCityEvidence(fact.evidence.code),
          }
        : fact.value;
    (projected[group] as unknown as Record<string, unknown>)[field] = value;
  }
  return projected;
}

function normalizeCityEvidence(value?: string): TurnHintCity['evidence'] {
  return value === 'municipality_compact' ||
    value === 'explicit_city' ||
    value === 'unique_district_alias' ||
    value === 'hotspot_alias'
    ? value
    : 'explicit_city';
}

import type { CandidateClaimField, RuleFactFieldPath } from './claim.types';
import {
  candidateValuesEquivalent,
  deriveFieldValueFromQuote,
  experienceValueSupportedByQuote,
  normalizedIncludes,
} from './normalize';

/**
 * 字段风险分级（方案 §5.2；2026-08-12 按宪法 P11 重述）。
 *
 * 三档不再决定"允许多大程度的推导"（推导权已归还模型），只决定**出处检查形态**：
 * - strict_identity（姓名/手机号）：值本体必须逐字落在引文内；
 * - normalizable / boolean_identity：不复算值，只受短引文门约束。
 *
 * 原 `validateClaimValueAgainstQuote` 已随 C1/C3 删除（语义否决），检查移入 ./notary.ts。
 */

export type CandidateFieldRisk = 'strict_identity' | 'normalizable' | 'boolean_identity';

export const CANDIDATE_FIELD_RISK: Record<CandidateClaimField, CandidateFieldRisk> = {
  name: 'strict_identity',
  phone: 'strict_identity',
  gender: 'normalizable',
  age: 'normalizable',
  isStudent: 'boolean_identity',
  education: 'normalizable',
  healthCertificate: 'normalizable',
  height: 'normalizable',
  weight: 'normalizable',
  householdProvince: 'normalizable',
};

/**
 * 短引文门（C5）的逐字段最小语境字数。0 = 值本身自解释，裸答合法。
 *
 * 定档判据：这个值裸着出现时是否可能在答别的问题。「有」「是」能答健康证/经验/
 * 时间/身份任意一问 → 要 3 字语境；「男」「24」「大专」裸着只可能指本字段 → 0。
 * 姓名/手机号走严格身份路径（值必须逐字在引文里），不参与本表。
 */
export const MIN_QUOTE_CONTEXT_CHARS: Record<CandidateClaimField, number> = {
  name: 0,
  phone: 0,
  gender: 0,
  age: 0,
  isStudent: 3,
  education: 0,
  healthCertificate: 3,
  height: 0,
  weight: 0,
  householdProvince: 0,
};

/**
 * 候选人明确提供时，允许由模型来源升级为候选人引文来源的 session 字段。
 *
 * 这是 session 提取与 evidence 裁决之间的策略，不属于 memory 的存储编排；字段增删必须
 * 在此处审阅。姓名仍走独立真名门，事务字段不得因候选人一句话升级成已确认副作用。
 */
export const EXPLICIT_EXTRACTION_UPGRADE_FIELDS: ReadonlySet<string> = new Set([
  'phone',
  'gender',
  'age',
  'education',
  'has_health_certificate',
  'experience',
  'height',
  'weight',
  'is_student',
  'household_register_province',
]);

/** 首次写入必须能从候选人自陈语料复算的身份族 session 字段。 */
export const IDENTITY_FIRST_WRITE_FIELDS: ReadonlySet<string> = new Set([
  'age',
  'gender',
  'education',
  'height',
  'weight',
  'experience',
]);

/** session 字段名到确定性 quote 解析器字段名的映射。 */
const PROVENANCE_DERIVATION_FIELDS: Readonly<Record<string, CandidateClaimField>> = {
  name: 'name',
  phone: 'phone',
  gender: 'gender',
  age: 'age',
  is_student: 'isStudent',
  education: 'education',
  has_health_certificate: 'healthCertificate',
  height: 'height',
  weight: 'weight',
  household_register_province: 'householdProvince',
};

/**
 * 判断候选人引文是否足以支持 session 提取的当前字段值。
 *
 * 合成式 experience 使用 token 覆盖；其余字段优先走确定性解析器。首写身份族只允许
 * 解析器等价或双向等价文本，不能退回宽松的单向包含；非首写升级字段保留既有的保守
 * 单向包含兜底。该函数只迁移既有策略，不改变任何准入行为。
 */
export function extractionQuoteSupportsCurrentValue(
  field: string,
  quote: string,
  currentValue: unknown,
): boolean {
  if (field === 'experience') {
    return experienceValueSupportedByQuote(quote, String(currentValue));
  }

  const derivationField = PROVENANCE_DERIVATION_FIELDS[field];
  if (!derivationField) return false;
  const derived = deriveFieldValueFromQuote(derivationField, quote);
  if (derived !== null) {
    return candidateValuesEquivalent(derivationField, derived, currentValue);
  }
  if (
    IDENTITY_FIRST_WRITE_FIELDS.has(field) &&
    normalizedIncludes(quote, String(currentValue)) &&
    normalizedIncludes(String(currentValue), quote)
  ) {
    return true;
  }
  return !IDENTITY_FIRST_WRITE_FIELDS.has(field) && normalizedIncludes(quote, String(currentValue));
}

// PR #1000 评审 P3：曾有一张 FIELD_POLICIES 全字段策略表（producerPriority/conflict）
// 声明为「策略差异唯一居所」，但引擎从未读它——真正生效的策略是下方
// RULE_FACT_FIELD_POLICIES 与 engine/merge 的实现。为避免两套并存的假权威，已删除；
// 若未来引擎真按表驱动，再从版本历史恢复并接线。

export type RuleFactSelection = 'first-scalar' | 'last-scalar' | 'union-array' | 'composite';

export interface RuleFactFieldPolicy {
  selection: RuleFactSelection;
  allowedOperations: readonly ('set' | 'clear')[];
  /** composite 投影的固定形状；producer 的 null 不参与覆盖，但消费者仍看到完整对象。 */
  defaults?: Readonly<Record<string, unknown>>;
}

/**
 * rule-track 的逐字段归并参数。producer 只发 claim，不得依据这些语义自行吞并；
 * first/last/union/composite 全部在 evidence/merge 的同一条 claim 流上执行。
 */
export const RULE_FACT_FIELD_POLICIES = {
  'interview_info.name': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.phone': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.gender': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.gender_source': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.age': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.is_student': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.education': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.has_health_certificate': {
    selection: 'last-scalar',
    allowedOperations: ['set'],
  },
  'interview_info.experience': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.upload_resume': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.height': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.weight': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.household_register_province': {
    selection: 'first-scalar',
    allowedOperations: ['set'],
  },
  'preferences.salary': { selection: 'first-scalar', allowedOperations: ['set'] },
  'preferences.position': { selection: 'union-array', allowedOperations: ['set', 'clear'] },
  'preferences.schedule': { selection: 'first-scalar', allowedOperations: ['set'] },
  'preferences.city': { selection: 'last-scalar', allowedOperations: ['set', 'clear'] },
  'preferences.district': { selection: 'union-array', allowedOperations: ['set', 'clear'] },
  'preferences.location': { selection: 'union-array', allowedOperations: ['set', 'clear'] },
  'preferences.labor_form': { selection: 'last-scalar', allowedOperations: ['set', 'clear'] },
  'preferences.schedule_constraint': {
    selection: 'composite',
    allowedOperations: ['set', 'clear'],
    defaults: {
      onlyWeekends: null,
      onlyEvenings: null,
      onlyMornings: null,
      maxDaysPerWeek: null,
    },
  },
  'preferences.available_after': {
    selection: 'last-scalar',
    allowedOperations: ['set', 'clear'],
  },
} as const satisfies Record<RuleFactFieldPath, RuleFactFieldPolicy>;

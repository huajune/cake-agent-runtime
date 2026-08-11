import type {
  CandidateClaimField,
  CandidateClaimRejectionReason,
  CandidateFactClaim,
  EvidenceField,
  EvidenceOperation,
  RuleFactFieldPath,
} from './claim.types';
import {
  candidateValuesEquivalent,
  deriveFieldValueFromQuote,
  isValidCandidateFieldShape,
} from './normalize';

/**
 * 字段风险分级策略（方案 §5.2）。
 *
 * 三档：
 * - strict_identity（姓名/手机号）：只接受直接原文/明确纠正/绑定确认——quote 里
 *   必须逐字含所声明的值本体，禁止任何自由推导（"从语气判断她姓王"不成立）。
 * - normalizable（身高/体重/年龄/学历/户籍/性别/健康证）：允许单位换算、格式
 *   归一化与白名单语义映射，但归一化结果必须能由 quote 确定性复算。
 * - boolean_identity（学生身份）：走 identity-statement 词典分类验证，改口核实
 *   等状态机语义仍由既有 resolveIdentityFlipAfterRejection 承担，不在本层重造。
 *
 * 本层只做"值与证据的关系"验证；quote 是否真是候选人说的（在候选人消息集中
 * 子串命中）由裁决器先行验证，进到这里的 quote 已确认出自候选人。
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

export interface FieldPolicy {
  allowedOperations: readonly EvidenceOperation[];
  producerPriority: readonly string[];
  conflict: 'reject' | 'latest' | 'union' | 'composite';
}

const CANDIDATE_POLICY: FieldPolicy = {
  allowedOperations: ['set', 'correct', 'confirm', 'clear'],
  producerPriority: ['human', 'rule', 'confirmation_resolver', 'model', 'archive'],
  conflict: 'reject',
};

/** 策略差异只能落在这张穷尽表，字段不得自带第二套引擎。 */
export const FIELD_POLICIES: Record<EvidenceField, FieldPolicy> = {
  name: CANDIDATE_POLICY,
  phone: CANDIDATE_POLICY,
  gender: CANDIDATE_POLICY,
  age: CANDIDATE_POLICY,
  isStudent: CANDIDATE_POLICY,
  education: CANDIDATE_POLICY,
  healthCertificate: CANDIDATE_POLICY,
  height: CANDIDATE_POLICY,
  weight: CANDIDATE_POLICY,
  householdProvince: CANDIDATE_POLICY,
  city: {
    allowedOperations: ['set', 'correct', 'confirm', 'clear'],
    producerPriority: [
      'confirmation',
      'rule',
      'allowlist',
      'geocode',
      'location_share',
      'map_screenshot',
      'model',
      'archive',
    ],
    conflict: 'latest',
  },
  district: {
    allowedOperations: ['set', 'clear'],
    producerPriority: ['rule', 'geocode', 'model', 'archive'],
    conflict: 'union',
  },
  location: {
    allowedOperations: ['set', 'clear'],
    producerPriority: ['rule', 'geocode', 'location_share', 'model', 'archive'],
    conflict: 'union',
  },
  brand: {
    allowedOperations: ['set', 'exclude', 'clear'],
    producerPriority: ['user_text', 'image_description', 'contact_name'],
    conflict: 'composite',
  },
};

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

export interface ClaimValidationFailure {
  reason: CandidateClaimRejectionReason;
  detail: string;
}

/**
 * 验证"claim 声明的值能否被其 quote 支持"。返回 null = 通过。
 *
 * context_confirmation 解释：确认式应答（"对/是的"）本身不含值，值的合法性
 * 由绑定的 Agent 问句携带——要求 agentQuestionQuote 含值本体（严格字段）或
 * 可推导出等价值（可归一化字段）。确认只提升被询问的字段（方案 §5.2），
 * 扩散控制由 producer 侧保证（只对悬挂问句字段产 confirm claim）。
 */
export function validateClaimValueAgainstQuote(
  claim: CandidateFactClaim,
  now: Date = new Date(),
): ClaimValidationFailure | null {
  // clear 是显式清除，不携带值，无需值验证（quote 命中候选人原文即可）。
  if (claim.operation === 'clear') return null;

  if (!isValidCandidateFieldShape(claim.field, claim.value)) {
    return { reason: 'invalid_value_shape', detail: `值形状非法: ${String(claim.value)}` };
  }

  const risk = CANDIDATE_FIELD_RISK[claim.field];

  // 身份唯一识别器（identity-statement 状态机）产出的 isStudent claim：识别器
  // 本身就是确定性验证器（确认问句检测+纯肯定应答/二选一短答案词典），quote 是
  // "是的"类纯应答时词典复算必然推不出值，复核交给识别器担保。模型产的身份
  // claim 不享受此豁免，仍走下方词典复核。
  if (risk === 'boolean_identity' && claim.producer !== 'model') {
    return null;
  }

  const evidenceText =
    claim.interpretation === 'context_confirmation'
      ? (claim.evidence.agentQuestionQuote ?? '')
      : claim.evidence.quote;
  if (!evidenceText.trim()) {
    return { reason: 'quote_not_found', detail: '证据文本为空' };
  }

  if (risk === 'strict_identity') {
    // 严格身份字段：证据文本必须逐字包含值本体（手机号忽略分隔符）。
    const value = String(claim.value ?? '').trim();
    const haystack = claim.field === 'phone' ? evidenceText.replace(/[\s-]/g, '') : evidenceText;
    const needle = claim.field === 'phone' ? value.replace(/\D/g, '') : value;
    if (!needle || !haystack.includes(needle)) {
      return {
        reason: 'strict_field_free_derivation',
        detail: `严格字段 ${claim.field} 的证据未逐字含值`,
      };
    }
    return null;
  }

  // 可归一化字段与学生身份：从证据文本确定性复算，结果须与声明值等价。
  const derived = deriveFieldValueFromQuote(claim.field, evidenceText, now);
  if (derived === null) {
    return { reason: 'value_not_derivable', detail: `无法从证据推导 ${claim.field}` };
  }
  if (!candidateValuesEquivalent(claim.field, derived, claim.value)) {
    return {
      reason: 'value_not_derivable',
      detail: `推导值 ${String(derived)} 与声明值 ${String(claim.value)} 不等价`,
    };
  }
  return null;
}

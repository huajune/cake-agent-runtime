import type { CandidateParseResult } from './types';

export function parseAge(text: string): CandidateParseResult<number> | null {
  const candidateText = text
    .replace(
      /(?:岗位)?(?:年龄)?(?:要求|需要|限|须)[^，。！？；;\n\r]*?\d{2}\s*(?:[-~至到]\s*\d{2})?\s*(?:周?岁|岁以上|岁以下|以上|以下)?/gu,
      '',
    )
    .replace(/\d{2}\s*[-~至到]\s*\d{2}\s*(?:周?岁|岁)?/gu, '');
  // 结构化分支对已剥要求语境的 candidateText 匹配（PR #1000 评审 P1-13）：直接对
  // 原文匹配时，任意空白锚定会把「岗位要求 年龄22以上可做吗」的要求文本当表单回填
  // （vkikct39 族）；先 scrub 再匹配，内联表单「性别男 年龄28」仍可召回。
  const structured = /(?:^|[\n\r\s])年龄\s*[：:\s]?\s*(\d{2})(?!\s*[-~至到])(?=\D|$)/u.exec(
    candidateText,
  );
  const ageWithUnit = /(\d{2})\s*岁/u.exec(candidateText);
  const currentAge = /今年\s*(\d{2})/u.exec(candidateText);
  const match = structured ?? ageWithUnit ?? currentAge;
  const raw = match?.[1];
  if (!raw) return null;
  const age = Number(raw);
  return Number.isInteger(age) && age >= 14 && age <= 70
    ? { value: age, excerpt: match[0].trim() }
    : null;
}

export function isPlausibleAgeValue(value: unknown): boolean {
  const age = Number(String(value ?? '').replace(/岁$/u, ''));
  return Number.isInteger(age) && age >= 14 && age <= 70;
}

// ==================== 年龄区间判据（岗位/契约要求 vs 候选人年龄） ====================
//
// 原居所 `tools/duliday/precheck/age.util.ts` 随收资表单状态机迁入。
// 判据逻辑一字未改；差别只在**上下限的来源**：旧路从岗位 ageRequirement 文本解析，
// 新路由收资标签契约的 minAge/maxAge 直接给出（0818 判决单源约定——收资/筛选判决的
// 唯一判据源是报名筛选标签接口，不读岗位数据补筛）。因此本族只收数值区间，
// 不认识任何岗位文本。

/** 年龄边界弹性下限：候选人年龄 ≥ 此值且距岗位下限 ≤ LOWER_TOLERANCE 时视为弹性范围。 */
export const AGE_BOUNDARY_HANDOFF_FLOOR = 23;

/** 年龄边界弹性：低于岗位下限不超过此值时视为弹性范围。 */
export const AGE_BOUNDARY_LOWER_TOLERANCE_YEARS = 2;

/** 年龄边界弹性：超过岗位上限不超过此值时视为弹性范围。 */
export const AGE_BOUNDARY_UPPER_TOLERANCE_YEARS = 3;

export interface AgeScreeningSignal {
  candidateAge: number | null;
  requiredMin: number | null;
  requiredMax: number | null;
  /**
   * - 'pass'：完全符合岗位年龄要求
   * - 'boundary'：差一点点，弹性范围内，可继续推进
   * - 'hard_reject'：远超弹性范围，必须拦截
   * - 'unknown'：候选人年龄或岗位年龄要求未知，无法判断
   */
  severity: 'pass' | 'boundary' | 'hard_reject' | 'unknown';
  /** 仅 boundary / hard_reject 时有值 */
  side?: 'under_min' | 'over_max';
  reason: string;
}

/**
 * 候选人年龄 vs 岗位要求筛选检测。始终返回具体信号，不返回 null。
 */
export function detectAgeBoundary(params: {
  candidateAge: number | null;
  range: { min: number | null; max: number | null } | null;
}): AgeScreeningSignal {
  const { candidateAge, range } = params;

  if (candidateAge === null && range === null) {
    return {
      candidateAge: null,
      requiredMin: null,
      requiredMax: null,
      severity: 'unknown',
      reason: '候选人年龄和岗位年龄要求均未知，无法判断。',
    };
  }
  if (candidateAge === null) {
    return {
      candidateAge: null,
      requiredMin: range!.min,
      requiredMax: range!.max,
      severity: 'unknown',
      reason: '候选人年龄未知，无法判断是否符合岗位要求。',
    };
  }
  if (range === null) {
    return {
      candidateAge,
      requiredMin: null,
      requiredMax: null,
      severity: 'unknown',
      reason: '岗位无年龄要求或年龄要求未知。',
    };
  }

  const { min, max } = range;

  // 低于下限
  if (min !== null && candidateAge < min) {
    const gap = min - candidateAge;
    const isBoundary =
      candidateAge >= AGE_BOUNDARY_HANDOFF_FLOOR && gap <= AGE_BOUNDARY_LOWER_TOLERANCE_YEARS;
    return {
      candidateAge,
      requiredMin: min,
      requiredMax: max,
      side: 'under_min',
      severity: isBoundary ? 'boundary' : 'hard_reject',
      reason: isBoundary
        ? `候选人 ${candidateAge} 岁，岗位下限 ${min} 岁；差 ${gap} 岁在弹性范围内，可继续推进。`
        : `候选人 ${candidateAge} 岁，岗位下限 ${min} 岁；差 ${gap} 岁远超弹性范围，必须拦截。`,
    };
  }

  // 高于上限
  if (max !== null && candidateAge > max) {
    const isBoundary = candidateAge <= max + AGE_BOUNDARY_UPPER_TOLERANCE_YEARS;
    return {
      candidateAge,
      requiredMin: min,
      requiredMax: max,
      side: 'over_max',
      severity: isBoundary ? 'boundary' : 'hard_reject',
      reason: isBoundary
        ? `候选人 ${candidateAge} 岁，岗位上限 ${max} 岁；超 ${candidateAge - max} 岁在弹性范围内，可继续推进。`
        : `候选人 ${candidateAge} 岁，岗位上限 ${max} 岁；超 ${candidateAge - max} 岁远超弹性范围，必须拦截。`,
    };
  }

  // 完全符合
  return {
    candidateAge,
    requiredMin: min,
    requiredMax: max,
    severity: 'pass',
    reason: `候选人 ${candidateAge} 岁，符合岗位年龄要求${min != null && max != null ? ` ${min}-${max} 岁` : ''}。`,
  };
}

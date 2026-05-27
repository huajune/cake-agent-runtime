/**
 * 候选人年龄解析 + 岗位年龄筛选信号检测。
 *
 * - parseCandidateAge：从候选人输入（"24" / "24岁" 等）解析数字
 * - parseAgeRange：从岗位 ageRequirement（"25-50岁" / "不限"）解析数值上下限
 * - detectAgeBoundary：始终返回具体筛选信号，不返回 null
 *   - severity='pass'：完全符合
 *   - severity='boundary'：弹性范围内，可继续推进
 *   - severity='hard_reject'：远超弹性范围，必须拦截
 *   - severity='unknown'：年龄或范围缺失，无法判断
 */

export function parseCandidateAge(ageText: string | null | undefined): number | null {
  if (!ageText) return null;
  const match = ageText.match(/\d+/);
  if (!match) return null;
  const age = parseInt(match[0], 10);
  return Number.isFinite(age) ? age : null;
}

/**
 * 解析岗位年龄要求文本 `"25-50岁"` 等 → 数值上下限。
 *
 * 输入由 job-policy-parser 统一格式化：`"<min>-<max>岁"`，单边可能写 "不限"。
 * 解析失败或无明确范围时返回 null。
 */
export function parseAgeRange(
  ageRequirement: string | null | undefined,
): { min: number | null; max: number | null } | null {
  if (!ageRequirement) return null;
  if (ageRequirement === '不限') return null;
  const match = ageRequirement.match(/(?:(\d+)|不限)\s*-\s*(?:(\d+)|不限)/);
  if (!match) return null;
  const min = match[1] ? parseInt(match[1], 10) : null;
  const max = match[2] ? parseInt(match[2], 10) : null;
  if (min === null && max === null) return null;
  return { min, max };
}

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

/** @deprecated 使用 AgeScreeningSignal */
export type AgeBoundarySignal = AgeScreeningSignal;

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

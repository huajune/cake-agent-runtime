/**
 * 候选人年龄解析 + 岗位年龄边界 handoff 信号检测。
 *
 * 从 duliday-interview-precheck.tool.ts 拆出（Phase 1.A 机械搬运，0 逻辑改动）：
 * - parseCandidateAge：从候选人输入（"24" / "24岁" 等）解析数字
 * - parseAgeRange：从岗位 ageRequirement（"25-50岁" / "不限"）解析数值上下限
 * - detectAgeBoundary：候选人在"差一点点"边界时返回 handoff 信号（badcase zmp4egzr）
 *
 * AGE_BOUNDARY_HANDOFF_FLOOR / AGE_BOUNDARY_UPPER_TOLERANCE_YEARS 是业务侧定义的
 * 边界容忍——候选人 ≥ 23 岁且差年龄下限 ≤ 2 岁、或超上限 ≤ 3 岁时，不直接劝退，
 * 走 request_handoff 转人工，由招募经理决定是否破例登记。
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

/** 年龄边界 handoff 下限：候选人年龄 ≥ 此值且距岗位下限 ≤ 2 岁时走 handoff。 */
export const AGE_BOUNDARY_HANDOFF_FLOOR = 23;

/** 年龄边界 handoff 上限容忍：超过岗位上限不多于此值时也走 handoff。 */
export const AGE_BOUNDARY_UPPER_TOLERANCE_YEARS = 3;

export interface AgeBoundarySignal {
  candidateAge: number;
  requiredMin: number | null;
  requiredMax: number | null;
  /** 'under_min' = 年龄略低于下限；'over_max' = 年龄略高于上限 */
  side: 'under_min' | 'over_max';
  reason: string;
}

/**
 * 判定"差一点点"的年龄边界——避免 Agent 直接以年龄硬门槛劝退候选人。
 *
 * 历史 badcase：候选人 24 岁，岗位要求 25-50 岁，Agent 直接劝退。
 * 业务侧希望边界 case 走人工兜底（招募经理可以申请按 25 岁登记），不要让
 * Agent 自己关门。
 *
 * 边界规则：
 * - 下限：候选人年龄 ≥ AGE_BOUNDARY_HANDOFF_FLOOR 且 < required_min → handoff
 * - 上限：候选人年龄 > required_max 且 ≤ required_max + AGE_BOUNDARY_UPPER_TOLERANCE_YEARS → handoff
 *
 * 不在边界范围内（差距太大）的硬拒绝继续按原逻辑走，本函数返回 null。
 */
export function detectAgeBoundary(params: {
  candidateAge: number | null;
  range: { min: number | null; max: number | null } | null;
}): AgeBoundarySignal | null {
  const { candidateAge, range } = params;
  if (candidateAge === null || range === null) return null;

  const { min, max } = range;
  if (min !== null && candidateAge >= AGE_BOUNDARY_HANDOFF_FLOOR && candidateAge < min) {
    return {
      candidateAge,
      requiredMin: min,
      requiredMax: max,
      side: 'under_min',
      reason: `候选人 ${candidateAge} 岁，岗位下限 ${min} 岁；差距 ${
        min - candidateAge
      } 岁在边界容忍内（≥ ${AGE_BOUNDARY_HANDOFF_FLOOR} 岁），不要直接劝退，转人工由招募经理决定。`,
    };
  }
  if (
    max !== null &&
    candidateAge > max &&
    candidateAge <= max + AGE_BOUNDARY_UPPER_TOLERANCE_YEARS
  ) {
    return {
      candidateAge,
      requiredMin: min,
      requiredMax: max,
      side: 'over_max',
      reason: `候选人 ${candidateAge} 岁，岗位上限 ${max} 岁；超出 ${
        candidateAge - max
      } 岁在边界容忍内（≤ ${AGE_BOUNDARY_UPPER_TOLERANCE_YEARS} 岁），不要直接劝退，转人工由招募经理决定。`,
    };
  }
  return null;
}

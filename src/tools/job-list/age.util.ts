/**
 * 岗位年龄要求**文本**解析（岗位侧，展示/话术域）。
 *
 * - parseCandidateAge：从候选人输入（"24" / "24岁" 等）解析数字
 * - parseAgeRange：从岗位 ageRequirement（"25-50岁" / "不限"）解析数值上下限
 *
 * ⚠️ 判据函数 `detectAgeBoundary` 与三个弹性常量住在 `@resolution/candidate/age`：
 * 「候选人年龄 vs 数值区间」是候选人字段判据，且 `.eslintrc.js` 禁止 resolution 依赖
 * @tools/*。留在本文件的只有岗位自由文本解析——岗位文本轨的职责已收窄为展示/话术。
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

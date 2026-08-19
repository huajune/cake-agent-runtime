import type { IdentityEvidence } from '@resolution/candidate/student-identity';

/**
 * 标准候选人字段与岗位补充标签的确定性重叠表。
 *
 * 这里只做“同一问题的两个户口”桥接，不做身份语义换算：候选人说“社会人士”，
 * 回填学籍标签的仍是逐字原话“社会人士”，不会擅自改写成“学信网不在籍”。
 */
const STANDARD_FIELD_SUPPLEMENT_OVERLAPS = [
  {
    standardField: '身份',
    labelPatterns: [
      /学信网.*(?:学籍|在籍).*(?:状态|情况)?/u,
      /(?:学籍|在籍)(?:状态|情况)/u,
      /是否(?:是)?学信网在籍学生/u,
    ],
  },
] as const;

export function isIdentityStatusSupplementLabel(labelName: string): boolean {
  const mapping = STANDARD_FIELD_SUPPLEMENT_OVERLAPS[0];
  return mapping.labelPatterns.some((pattern) => pattern.test(labelName.trim()));
}

export function buildIdentitySupplementAnswerBackfills(params: {
  labelNames: readonly string[];
  identityEvidence: IdentityEvidence | null;
  providedAnswers?: Record<string, string>;
}): Record<string, string> {
  const result = { ...(params.providedAnswers ?? {}) };
  if (!params.identityEvidence) return result;

  for (const labelName of params.labelNames) {
    if (!isIdentityStatusSupplementLabel(labelName)) continue;
    if (hasProvidedAnswerForLabel(result, labelName)) continue;
    result[labelName] = params.identityEvidence.evidence;
  }
  return result;
}

function hasProvidedAnswerForLabel(answers: Record<string, string>, labelName: string): boolean {
  const normalizedLabel = normalizeKey(labelName);
  return Object.entries(answers).some(
    ([key, value]) => normalizeKey(key) === normalizedLabel && value.trim().length > 0,
  );
}

function normalizeKey(value: string): string {
  return value.replace(/\s+/gu, '').trim();
}

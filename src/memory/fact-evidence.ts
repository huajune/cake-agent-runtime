/** 模型提炼时的证据预算；按 Unicode 码点计数，不是原话/存储的截断上限。 */
export const MAX_FACT_EVIDENCE_CHARS = 200;

export const FACT_EVIDENCE_REJECTION = {
  MISSING: 'missing',
  EMPTY: 'empty',
  OVER_BUDGET: 'over_budget',
} as const;

export interface FactEvidenceIssue {
  reason: (typeof FACT_EVIDENCE_REJECTION)[keyof typeof FACT_EVIDENCE_REJECTION];
  characters: number;
}

/** 只去首尾空白，绝不删除证据正文（包括末尾的否定、条件和日期）。 */
export function normalizeFactEvidence(evidence: string): string {
  return evidence.trim();
}

export function isValidExtractedEvidence(evidence: unknown): evidence is string {
  return inspectExtractedEvidence(evidence) === null;
}

/** 只记录拒绝类型和长度，不把候选人原文写进诊断。 */
export function inspectExtractedEvidence(evidence: unknown): FactEvidenceIssue | null {
  if (typeof evidence !== 'string')
    return { reason: FACT_EVIDENCE_REJECTION.MISSING, characters: 0 };
  const characters = Array.from(evidence.trim()).length;
  if (characters === 0) return { reason: FACT_EVIDENCE_REJECTION.EMPTY, characters };
  if (characters > MAX_FACT_EVIDENCE_CHARS)
    return { reason: FACT_EVIDENCE_REJECTION.OVER_BUDGET, characters };
  return null;
}

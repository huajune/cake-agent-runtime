/** 模型提炼时的证据预算；按 Unicode 码点计数，不是原话/存储的截断上限。 */
export const MAX_FACT_EVIDENCE_CHARS = 200;

/** 只去首尾空白，绝不删除证据正文（包括末尾的否定、条件和日期）。 */
export function normalizeFactEvidence(evidence: string): string {
  return evidence.trim();
}

export function isValidExtractedEvidence(evidence: unknown): evidence is string {
  return (
    typeof evidence === 'string' &&
    evidence.trim().length > 0 &&
    Array.from(evidence.trim()).length <= MAX_FACT_EVIDENCE_CHARS
  );
}

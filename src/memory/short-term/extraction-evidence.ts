import { isValidExtractedEvidence, normalizeFactEvidence } from '../fact-evidence';

/** 按字段拒绝不完整的模型增量；不截断，也不把缺证据解释为撤销旧事实。 */
export function admitPreferenceEvidence(
  preferences: Record<string, unknown>,
  evidence: Record<string, string> | undefined,
  citations: Record<string, string | undefined> = {},
): { evidence: Record<string, string>; rejected: string[] } {
  const admitted: Record<string, string> = {};
  const rejected: string[] = [];
  for (const [field, value] of Object.entries(preferences)) {
    if (value == null) continue;
    const text = evidence?.[field] ?? citations[field];
    if (!isValidExtractedEvidence(text)) {
      preferences[field] = null;
      rejected.push(field);
    } else {
      admitted[field] = normalizeFactEvidence(text);
    }
  }
  return { evidence: admitted, rejected };
}

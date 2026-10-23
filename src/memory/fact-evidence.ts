/** 事实证据的存储上限，含截断标记；与 PostgreSQL length(text) 同为 Unicode 码点数。 */
export const MAX_FACT_EVIDENCE_CHARS = 200;

export function truncateEvidence(evidence: string, maxChars = MAX_FACT_EVIDENCE_CHARS): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (limit === 0) return '';
  const characters = Array.from(evidence.trim());
  if (characters.length <= limit) return characters.join('');
  return `${characters.slice(0, limit - 1).join('')}…`;
}

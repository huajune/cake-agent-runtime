import type { TextCitation, CitationVerificationResult } from './citation.types';
import { normalizedIncludes } from './text-normalization';

/** 只验证 citation 是否逐字命中给定来源语料，不解释其客观真假或业务含义。 */
export function verifyCitation(
  citation: TextCitation,
  sourceTexts: readonly string[],
): CitationVerificationResult {
  const quote = citation.quote.trim();
  if (!quote) {
    return { verified: false, reason: 'empty_citation', detail: 'citation 为空' };
  }
  if (!sourceTexts.some((text) => normalizedIncludes(text, quote))) {
    return { verified: false, reason: 'citation_not_found', detail: 'citation 未命中来源语料' };
  }
  return { verified: true };
}

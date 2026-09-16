import type { TextCitation, CitationVerificationResult } from './citation.types';
import { normalizeCitationText, normalizedIncludes } from './text-normalization';

const DIGIT_RUN_RE = /^\d+$/u;

/** 只验证 citation 是否逐字命中给定来源语料，不解释其客观真假或业务含义。 */
export function verifyCitation(
  citation: TextCitation,
  sourceTexts: readonly string[],
): CitationVerificationResult {
  const quote = citation.quote.trim();
  if (!quote) {
    return { verified: false, reason: 'empty_citation', detail: 'citation 为空' };
  }
  const normalizedQuote = normalizeCitationText(quote);
  if (DIGIT_RUN_RE.test(normalizedQuote)) {
    if (!sourceTexts.some((text) => includesDigitRunBounded(text, normalizedQuote))) {
      return {
        verified: false,
        reason: 'citation_not_found',
        detail: '纯数字 citation 未在来源语料中独立成数（不能是更长数字串里的一段）',
      };
    }
    return { verified: true };
  }
  if (!sourceTexts.some((text) => normalizedIncludes(text, quote))) {
    return { verified: false, reason: 'citation_not_found', detail: 'citation 未命中来源语料' };
  }
  return { verified: true };
}

/**
 * 纯数字引文的子串匹配是空证据：「22」「65」「160」几乎必然是某个手机号的一段。
 * 数字串必须在来源里独立成数——前后不能紧邻其他数字；空白视为分界（候选人一行一个数
 * 作答时不能被去空白折叠成一串），同时允许候选人在数字中间打空格（139 1038 4709）。
 */
function includesDigitRunBounded(haystack: string, digits: string): boolean {
  const pattern = new RegExp(`(?<!\\d)${digits.split('').join('\\s*')}(?!\\d)`, 'u');
  return pattern.test(haystack.normalize('NFKC'));
}

import type { TextCitation } from './citation.types';
import { normalizedIncludes } from './text-normalization';

const ECHO_MIN_QUOTE_CHARS = 4;

/** 引文是否也逐字存在于 Assistant 文本；命中只说明出处存疑，不代表内容为假。 */
export function detectAssistantEcho(
  citation: TextCitation,
  assistantTexts: readonly string[],
): boolean {
  const quote = citation.quote.trim();
  if (quote.replace(/\s+/gu, '').length < ECHO_MIN_QUOTE_CHARS) return false;
  return assistantTexts.some((text) => normalizedIncludes(text, quote));
}

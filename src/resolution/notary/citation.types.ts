export interface TextCitation {
  /** 模型或规则提出的逐字来源片段。 */
  quote: string;
}

export type CitationVerificationFailure = 'empty_citation' | 'citation_not_found';

export interface CitationVerificationResult {
  verified: boolean;
  reason?: CitationVerificationFailure;
  detail?: string;
}

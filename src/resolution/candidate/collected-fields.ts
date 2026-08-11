import { parseAge } from './age';
import { parseEducation } from './education';
import { parseGender } from './gender';
import { parseHealthCert } from './health-cert';
import { parseHeight, parseWeight } from './height-weight';
import { parseHouseholdProvince } from './household-province';
import { parseName } from './name';
import { parsePhone } from './phone';
import {
  AUTHORITATIVE_PRODUCERS,
  type CandidateCollectedField,
  type CandidateFieldKey,
  type CandidateParseResult,
} from './types';

const MAX_COLLECTED_EVIDENCE_CHARS = 200;

function truncateEvidence(evidence: string): string {
  const trimmed = evidence.trim();
  return trimmed.length <= MAX_COLLECTED_EVIDENCE_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_COLLECTED_EVIDENCE_CHARS)}…`;
}

export function isFieldAuthoritative(field?: CandidateCollectedField): boolean {
  return !!field && AUTHORITATIVE_PRODUCERS.has(field.producer);
}

export function parseCandidateFieldsFromText(
  userMessages: readonly string[],
  at: number,
): Partial<Record<CandidateFieldKey, CandidateCollectedField>> {
  const text = userMessages.join('\n');
  const fields: Partial<Record<CandidateFieldKey, CandidateCollectedField>> = {};
  const put = <T extends string | number>(
    key: CandidateFieldKey,
    result: CandidateParseResult<T> | null,
    fallbackLabel: string,
  ): void => {
    if (!result) return;
    const excerpt = truncateEvidence(result.excerpt);
    fields[key] = {
      value: result.value,
      producer: 'candidate_quote',
      evidence: excerpt || `「${String(result.value)}」（${fallbackLabel}）`,
      at,
    };
  };
  put('name', parseName(text), '原文结构化姓名/我叫');
  put('phone', parsePhone(text), '11位手机号');
  put('age', parseAge(text), '年龄数字');
  put('gender', parseGender(text), '性别表述');
  put('householdProvince', parseHouseholdProvince(text), '户籍省名');
  put('healthCert', parseHealthCert(text), '健康证表述');
  put('education', parseEducation(text), '学历关键词');
  put('height', parseHeight(text), '身高');
  put('weight', parseWeight(text), '体重');
  return fields;
}

import { stripQuotedBlocks, stripTimeContext } from '@resolution/signal/markers';
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
  // 逐条清洗后再 join（PR #1000 评审 P1-11）：不剥时间后缀则 `$` 锚定判据
  // （健康证紧凑答「没办过，可以办」等）在生产形态下永不成立；不剥引用块则
  // `[引用 店长：…138…]` 里经理的手机号/姓名会被当候选人字段预填进 precheck。
  const text = userMessages
    .map((message) => stripQuotedBlocks(stripTimeContext(message, '\n')).trim())
    .filter(Boolean)
    .join('\n');
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

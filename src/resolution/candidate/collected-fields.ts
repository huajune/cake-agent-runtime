import { parseAge } from './age';
import { parseEducation } from './education';
import { parseGender } from './gender';
import { parseHealthCert } from './health-cert';
import { parseHeight, parseWeight } from './height-weight';
import { parseHouseholdProvince } from './household-province';
import { parseName } from './name';
import { parsePhone } from './phone';

export type CandidateFieldKey =
  | 'name'
  | 'phone'
  | 'age'
  | 'gender'
  | 'education'
  | 'healthCert'
  | 'householdProvince'
  | 'height'
  | 'weight'
  | 'supplementAnswers';

export type CandidateFieldProvenance =
  | 'user_text'
  | 'booking_writeback'
  | 'llm_extract'
  | 'model_arg';

export interface CandidateCollectedField<T = string | number> {
  value: T;
  provenance: CandidateFieldProvenance;
  evidence?: string;
  at: number;
}

export const AUTHORITATIVE_PROVENANCE: ReadonlySet<CandidateFieldProvenance> = new Set([
  'user_text',
  'booking_writeback',
]);

export function isFieldAuthoritative(field?: CandidateCollectedField): boolean {
  return !!field && AUTHORITATIVE_PROVENANCE.has(field.provenance);
}

export function parseCandidateFieldsFromText(
  userMessages: readonly string[],
  at: number,
): Partial<Record<CandidateFieldKey, CandidateCollectedField>> {
  const text = userMessages.join('\n');
  const fields: Partial<Record<CandidateFieldKey, CandidateCollectedField>> = {};
  const put = (key: CandidateFieldKey, value: string | number | null, evidence: string): void => {
    if (value === null || value === undefined) return;
    fields[key] = { value, provenance: 'user_text', evidence, at };
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

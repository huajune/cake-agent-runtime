import type { CandidateParseResult } from './types';

export function parseAge(text: string): CandidateParseResult<number> | null {
  const structured = /(?:^|[\n\r\s])年龄\s*[：:\s]?\s*(\d{2})(?!\s*[-~至到])(?=\D|$)/u.exec(text);
  const candidateText = text
    .replace(
      /(?:岗位)?(?:年龄)?(?:要求|需要|限|须)[^，。！？；;\n\r]*?\d{2}\s*(?:[-~至到]\s*\d{2})?\s*(?:周?岁|岁以上|岁以下|以上|以下)?/gu,
      '',
    )
    .replace(/\d{2}\s*[-~至到]\s*\d{2}\s*(?:周?岁|岁)?/gu, '');
  const ageWithUnit = /(\d{2})\s*岁/u.exec(candidateText);
  const currentAge = /今年\s*(\d{2})/u.exec(candidateText);
  const match = structured ?? ageWithUnit ?? currentAge;
  const raw = match?.[1];
  if (!raw) return null;
  const age = Number(raw);
  return Number.isInteger(age) && age >= 14 && age <= 70
    ? { value: age, excerpt: match[0].trim() }
    : null;
}

export function isPlausibleAgeValue(value: unknown): boolean {
  const age = Number(String(value ?? '').replace(/岁$/u, ''));
  return Number.isInteger(age) && age >= 14 && age <= 70;
}

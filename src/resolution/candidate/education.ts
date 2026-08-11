import { findSpongeEducationIdByLabel } from '@sponge/sponge.enums';
import { containsLocationShareMarkup } from '@infra/utils/message-markup.util';

const EDUCATION_KEYWORDS: Array<[RegExp, string]> = [
  [/博士/u, '博士'],
  [/硕士|研究生/u, '硕士'],
  [/本科|大学本科/u, '本科'],
  [/大专|专科/u, '大专'],
  [/高职/u, '高职'],
  [/中专|技校|职高/u, '中专技校职高'],
  [/高中/u, '高中'],
  [/初中以下|小学/u, '初中以下'],
  [/初中/u, '初中'],
];

export function parseEducation(text: string): string | null {
  if (
    containsLocationShareMarkup(text) ||
    /(小学部|初中部|高中部|中学部|大学城|学校|校区|学院|幼儿园|附小)/u.test(text)
  )
    return null;
  for (const [pattern, label] of EDUCATION_KEYWORDS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

export function normalizeEducationToId(value: string): number | null {
  return findSpongeEducationIdByLabel(value);
}

import { findSpongeProvinceIdByName, getAvailableSpongeProvinces } from '@sponge/sponge.enums';

export function parseHouseholdProvince(text: string): string | null {
  const match =
    /(?:户籍|籍贯|老家|户口)(?:所在地|地)?\s*(?:是|在|为|地?[：:])?\s*([一-龥]{2,12})/u.exec(text);
  if (!match?.[1]) return null;
  const tail = match[1];
  const labels = getAvailableSpongeProvinces().sort((a, b) => b.length - a.length);
  for (const label of labels) {
    const normalized = label.replace(
      /壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省$|市$/u,
      '',
    );
    if (tail.startsWith(label)) return label;
    if (tail.startsWith(normalized)) return normalized;
  }
  return null;
}

export function normalizeProvinceToId(value: string): number | null {
  return findSpongeProvinceIdByName(value);
}

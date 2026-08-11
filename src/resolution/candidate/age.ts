export function parseAge(text: string): number | null {
  const structured = /(?:^|[\n\r\s])年龄\s*[：:\s]?\s*(\d{2})(?!\s*[-~至到])(?=\D|$)/u.exec(text);
  const candidateText = text
    .replace(
      /(?:岗位)?(?:年龄)?(?:要求|需要|限|须)[^，。！？；;\n\r]*?\d{2}\s*(?:[-~至到]\s*\d{2})?\s*(?:周?岁|岁以上|岁以下|以上|以下)?/gu,
      '',
    )
    .replace(/\d{2}\s*[-~至到]\s*\d{2}\s*(?:周?岁|岁)?/gu, '');
  const raw =
    structured?.[1] ??
    /(\d{2})\s*岁/u.exec(candidateText)?.[1] ??
    /今年\s*(\d{2})/u.exec(candidateText)?.[1];
  if (!raw) return null;
  const age = Number(raw);
  return Number.isInteger(age) && age >= 14 && age <= 70 ? age : null;
}

export function isPlausibleAgeValue(value: unknown): boolean {
  const age = Number(String(value ?? '').replace(/岁$/u, ''));
  return Number.isInteger(age) && age >= 14 && age <= 70;
}

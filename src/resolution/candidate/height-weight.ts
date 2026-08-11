const REQUIREMENT_CONTEXT_RE =
  /(?:要求|需要|限|须|不低于|不高于|至少|最低|最高|以上|以下|能做吗|可以吗)/u;

function hasRequirementContext(text: string, marker: '身高' | '体重'): boolean {
  const index = text.indexOf(marker);
  if (index < 0) return false;
  return REQUIREMENT_CONTEXT_RE.test(text.slice(Math.max(0, index - 8), index + 24));
}

export function parseHeight(text: string): number | null {
  if (hasRequirementContext(text, '身高')) return null;
  const raw = /身高\s*[：:]?\s*(\d{2,3})(?=\s*(?:cm|厘米|公分)?(?:$|[，,。;；！!\s]))/u.exec(
    text,
  )?.[1];
  const value = Number(raw);
  return raw && value >= 100 && value <= 250 ? value : null;
}

export function parseWeight(text: string): number | null {
  if (hasRequirementContext(text, '体重')) return null;
  const raw = /体重\s*[：:]?\s*(\d{2,3})(?=\s*(?:kg|公斤|千克)?(?:$|[，,。;；！!\s]))/iu.exec(
    text,
  )?.[1];
  const value = Number(raw);
  return raw && value >= 30 && value <= 200 ? value : null;
}

/**
 * 引文包含匹配的字符级归一：NFKC 全半角折叠 + 去空白。
 *
 * 刻意不折叠标点：标点承载否定分界，不能让「不，是学生」匹配伪造引文「不是学生」。
 */
export function normalizeCitationText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '');
}

export function normalizedIncludes(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizeCitationText(needle);
  if (!normalizedNeedle) return false;
  return normalizeCitationText(haystack).includes(normalizedNeedle);
}

import type { CandidateParseResult } from './types';

/** 中国大陆手机号的唯一结构正则；其它域只调用本模块函数或复用该只读模式。 */
export const CANDIDATE_PHONE_RE = /(?<!\d)(1[3-9]\d{9})(?!\d)/u;

/**
 * 全库唯一占位手机号表。
 *
 * prompt canary 注册表只读复用本集合；禁止在 guardrail / prompt 测试里复制第二份号码表。
 */
export const PLACEHOLDER_PHONES: ReadonlySet<string> = new Set([
  '13800138000',
  '13800000000',
  '13900139000',
  '12345678901',
]);

export function parsePhone(text: string): CandidateParseResult<string> | null {
  const match = CANDIDATE_PHONE_RE.exec(text);
  return match?.[1] ? { value: match[1], excerpt: match[0] } : null;
}

/** 简历/OCR 容忍 +86、空格和连字符后的手机号解析。 */
export function parseFlexiblePhone(text: string): string | null {
  const compact = text.replace(/(?:\+?86)[-\s]?(?=1\d)/gu, '').replace(/(?<=\d)[-\s](?=\d)/gu, '');
  return parsePhone(compact)?.value ?? null;
}

export function redactCandidatePhones(text: string, replacement: string): string {
  return text.replace(new RegExp(CANDIDATE_PHONE_RE.source, 'gu'), replacement);
}

export function isPlaceholderPhone(phone: string | null | undefined): boolean {
  const normalized = phone?.replace(/\D/g, '') ?? '';
  if (normalized.length !== 11) return false;
  return PLACEHOLDER_PHONES.has(normalized) || /^1(\d)\1{9}$/.test(normalized);
}

export function isStorableCandidatePhone(phone: string | null | undefined): boolean {
  const normalized = phone?.replace(/\D/g, '') ?? '';
  return normalized.length === 11 && parsePhone(normalized)?.value === normalized;
}

import { formatLocalDate, parseLocalDateStart } from '@infra/utils/date.util';

export const DELAYED_INTENT_MAX_AGE_DAYS = 30;

/** 仅比较结构化日期/事实时间，不尝试从“晚点、下周”等开放文本猜日期。 */
export function isExpiredTemporalFact(
  key: string,
  fact: { value: unknown; extractedAt?: string; updatedAt?: string },
  now = new Date(),
): boolean {
  if (key !== 'available_after' && key !== 'delayed_intent') return false;
  if (!fact.value || typeof fact.value !== 'object') return false;
  const value = fact.value as Record<string, unknown>;
  const date = key === 'available_after' ? value.date : value.until;
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    const parsed = parseLocalDateStart(date);
    return (
      Number.isFinite(parsed.getTime()) &&
      formatLocalDate(parsed) === date &&
      date < formatLocalDate(now)
    );
  }
  if (key !== 'delayed_intent') return false;
  const timestamp = Date.parse(fact.extractedAt ?? fact.updatedAt ?? '');
  return (
    Number.isFinite(timestamp) &&
    now.getTime() - timestamp >= DELAYED_INTENT_MAX_AGE_DAYS * 86_400_000
  );
}

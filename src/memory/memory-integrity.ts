import { normalizeHealthCertificateState } from '@resolution/candidate/health-certificate-state';
import { isValidLaborForm } from '@resolution/labor-form';
import { truncateEvidence } from './fact-evidence';
import { isExpiredTemporalFact } from './temporal-facts';
import type { SummaryEntry } from './long-term/long-term.types';

export function isValidSummaryEntry(value: unknown): value is SummaryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.summary === 'string' &&
    entry.summary.trim().length > 0 &&
    typeof entry.sessionId === 'string' &&
    entry.sessionId.trim().length > 0 &&
    typeof entry.startTime === 'string' &&
    Number.isFinite(Date.parse(entry.startTime)) &&
    typeof entry.endTime === 'string' &&
    Number.isFinite(Date.parse(entry.endTime)) &&
    Date.parse(entry.startTime) <= Date.parse(entry.endTime)
  );
}

const EDUCATION_ALIASES: Record<string, string> = {
  中专: '中专技校职高',
  技校: '中专技校职高',
  职高: '中专技校职高',
  专科: '大专',
  研究生: '硕士',
  小学: '初中以下',
};

/** 只清格式、闭集和时效；不推断开放语义、不改事实来源/时间、不再次换算 kg。 */
export function cleanMemoryFacts(input: unknown, now = new Date()): Record<string, unknown> | null {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid memory column shape');
  return Object.fromEntries(
    Object.entries(input).map(([key, raw]) => {
      if (raw == null) return [key, null];
      if (typeof raw !== 'object' || Array.isArray(raw) || !('value' in raw)) return [key, null];
      const fact = { ...raw } as { value: unknown; evidence?: string; updatedAt?: string };
      if (typeof fact.evidence === 'string') fact.evidence = truncateEvidence(fact.evidence);
      if (fact.value === null) return [key, fact];
      if (key === 'has_health_certificate') {
        const value = normalizeHealthCertificateState(fact.value);
        if (value === null) return [key, null];
        fact.value = value;
      } else if (['age', 'height', 'weight'].includes(key)) {
        if (
          typeof fact.value !== 'string' ||
          !(key === 'age' ? /^\d+$/u : /^\d+(?:\.\d+)?$/u).test(fact.value.trim())
        )
          return [key, null];
        fact.value = fact.value.trim();
      } else if (
        key === 'labor_form' &&
        (typeof fact.value !== 'string' || !isValidLaborForm(fact.value))
      ) {
        return [key, null];
      } else if (key === 'education' && typeof fact.value === 'string') {
        fact.value = EDUCATION_ALIASES[fact.value] ?? fact.value;
      }
      if (isExpiredTemporalFact(key, fact, now)) fact.value = null;
      return [key, fact];
    }),
  );
}

// business-rules: SH-05
import { isSameFactValue } from '@resolution/turn-hints/reducer';
import { effectiveScheduleKey } from '@resolution/schedule/equivalence';
import {
  CandidateScheduleConstraintSchema,
  StoredScheduleConstraintSchema,
  mergeScheduleConstraints,
} from '@resolution/schedule/types';
import {
  inspectExtractedEvidence,
  isValidExtractedEvidence,
  normalizeFactEvidence,
  FACT_EVIDENCE_REJECTION,
  MAX_FACT_EVIDENCE_CHARS,
  type FactEvidenceIssue,
} from '../fact-evidence';

export interface PreferenceEvidenceIssue extends FactEvidenceIssue {
  field: string;
}

/** 按字段拒绝不完整的模型增量；不截断，也不把缺证据解释为撤销旧事实。 */
export function admitPreferenceEvidence(
  preferences: Record<string, unknown>,
  evidence: Record<string, string> | undefined,
  citations: Record<string, string | undefined> = {},
  previous: Record<string, unknown> = {},
): {
  evidence: Record<string, string>;
  rejected: string[];
  issues: PreferenceEvidenceIssue[];
  unchanged: string[];
} {
  const admitted: Record<string, string> = {};
  const rejected: string[] = [];
  const issues: PreferenceEvidenceIssue[] = [];
  const unchanged: string[] = [];
  for (const [field, value] of Object.entries(preferences)) {
    if (value == null) continue;
    if (isUnchangedPreference(field, value, previous[field])) {
      preferences[field] = null;
      unchanged.push(field);
      continue;
    }
    // 通用证据为空/超长时，仍允许合法的专用原话进入后续引用核验。
    const primary = evidence?.[field];
    const citation = citations[field];
    const text = isValidExtractedEvidence(primary)
      ? primary
      : isValidExtractedEvidence(citation)
        ? citation
        : (primary ?? citation);
    const issue = inspectExtractedEvidence(text);
    if (issue) {
      preferences[field] = null;
      rejected.push(field);
      issues.push({ field, ...issue });
    } else {
      admitted[field] = normalizeFactEvidence(text!);
    }
  }
  return { evidence: admitted, rejected, issues, unchanged };
}

export function formatPreferenceEvidenceIssue(issue: PreferenceEvidenceIssue): string {
  const labels = {
    [FACT_EVIDENCE_REJECTION.MISSING]: '证据缺失',
    [FACT_EVIDENCE_REJECTION.EMPTY]: '证据为空',
    [FACT_EVIDENCE_REJECTION.OVER_BUDGET]: `证据超长（${issue.characters}/${MAX_FACT_EVIDENCE_CHARS} 字符）`,
  };
  return `${issue.field}: ${labels[issue.reason]} [${issue.reason}]`;
}

/** 回显不产生增量；部分排班 patch 按真实合并语义比较，显式撤销仍是变更。 */
function isUnchangedPreference(field: string, value: unknown, previous: unknown): boolean {
  if (field !== 'schedule_constraint') return isSameFactValue(value, previous);
  const patch = CandidateScheduleConstraintSchema.safeParse(value);
  const stored = StoredScheduleConstraintSchema.nullable().safeParse(previous ?? null);
  if (!patch.success || !stored.success) return false;
  return (
    effectiveScheduleKey(mergeScheduleConstraints(stored.data, patch.data)) ===
    effectiveScheduleKey(stored.data)
  );
}

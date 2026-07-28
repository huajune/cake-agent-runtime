export type BadcaseEvidenceKind = 'scenario' | 'conversation';
export type BadcaseEvidenceReviewStatus = 'passed' | 'failed' | 'pending';
export type BadcaseEvidenceOverallStatus = 'passed' | 'failed' | 'pending' | 'partial' | 'missing';

export type BadcasePriority = 'P0' | 'P1' | 'P2';

export type BadcaseTreatmentConclusion =
  | '待归因'
  | '修复验证通过'
  | '已上线待观察'
  | '非Agent'
  | '重复'
  | '过时'
  | '转产品需求';

export type BadcasePendingParty = '无' | '运营' | '产品' | '技术' | '数据';

export interface BadcaseEvidenceEntry {
  kind: BadcaseEvidenceKind;
  batchId: string;
  assetIds: string[];
  executionIds: string[];
  reviewStatus: BadcaseEvidenceReviewStatus;
  reviewerSources: string[];
  reviewedAt: string | null;
}

export interface BadcaseEvidenceLedger {
  schemaVersion: 1;
  updatedAt: string;
  scenario: BadcaseEvidenceEntry[];
  conversation: BadcaseEvidenceEntry[];
  overallStatus: BadcaseEvidenceOverallStatus;
}

export interface BadcaseEvidenceUpdate {
  kind: BadcaseEvidenceKind;
  batchId: string;
  assetIds: string[];
  executionIds: string[];
  reviewStatus: BadcaseEvidenceReviewStatus;
  reviewerSources: string[];
  reviewedAt: string | null;
}

const MAX_EVIDENCE_ENTRIES_PER_KIND = 20;

function uniqueStrings<T extends string>(values: ReadonlyArray<T | null | undefined>): T[] {
  return [...new Set(values.filter((value): value is T => !!value))];
}

function normalizeEntry(entry: BadcaseEvidenceUpdate | BadcaseEvidenceEntry): BadcaseEvidenceEntry {
  return {
    kind: entry.kind,
    batchId: entry.batchId,
    assetIds: uniqueStrings(entry.assetIds),
    executionIds: uniqueStrings(entry.executionIds),
    reviewStatus: entry.reviewStatus,
    reviewerSources: uniqueStrings(entry.reviewerSources),
    reviewedAt: entry.reviewedAt ?? null,
  };
}

function latestEntry(entries: BadcaseEvidenceEntry[]): BadcaseEvidenceEntry | undefined {
  // mergeBadcaseEvidence always prepends the newest batch. This ordering also keeps a
  // newly-created PENDING batch newer than an older reviewed batch with reviewedAt set.
  return entries[0];
}

export function computeBadcaseEvidenceOverallStatus(
  ledger: Pick<BadcaseEvidenceLedger, 'scenario' | 'conversation'>,
): BadcaseEvidenceOverallStatus {
  const scenario = latestEntry(ledger.scenario);
  const conversation = latestEntry(ledger.conversation);

  if (!scenario && !conversation) return 'missing';
  if (scenario?.reviewStatus === 'failed' || conversation?.reviewStatus === 'failed') {
    return 'failed';
  }
  if (scenario?.reviewStatus === 'pending' || conversation?.reviewStatus === 'pending') {
    return 'pending';
  }
  if (scenario?.reviewStatus === 'passed' && conversation?.reviewStatus === 'passed') {
    return 'passed';
  }
  return 'partial';
}

export function createEmptyBadcaseEvidenceLedger(now = new Date()): BadcaseEvidenceLedger {
  return {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    scenario: [],
    conversation: [],
    overallStatus: 'missing',
  };
}

export function parseBadcaseEvidenceLedger(
  value: unknown,
  now = new Date(),
): BadcaseEvidenceLedger {
  if (!value) return createEmptyBadcaseEvidenceLedger(now);

  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return createEmptyBadcaseEvidenceLedger(now);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return createEmptyBadcaseEvidenceLedger(now);
  }

  const record = parsed as Partial<BadcaseEvidenceLedger>;
  const scenario = Array.isArray(record.scenario)
    ? record.scenario.filter(isBadcaseEvidenceEntry).map(normalizeEntry)
    : [];
  const conversation = Array.isArray(record.conversation)
    ? record.conversation.filter(isBadcaseEvidenceEntry).map(normalizeEntry)
    : [];
  const ledger: BadcaseEvidenceLedger = {
    schemaVersion: 1,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : now.toISOString(),
    scenario,
    conversation,
    overallStatus: 'missing',
  };
  ledger.overallStatus = computeBadcaseEvidenceOverallStatus(ledger);
  return ledger;
}

export function mergeBadcaseEvidence(
  current: BadcaseEvidenceLedger,
  update: BadcaseEvidenceUpdate,
  now = new Date(),
): BadcaseEvidenceLedger {
  const normalizedUpdate = normalizeEntry(update);
  const target = update.kind === 'scenario' ? current.scenario : current.conversation;
  const merged = [
    normalizedUpdate,
    ...target.filter((entry) => entry.batchId !== normalizedUpdate.batchId),
  ].slice(0, MAX_EVIDENCE_ENTRIES_PER_KIND);
  const ledger: BadcaseEvidenceLedger = {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    scenario: update.kind === 'scenario' ? merged : current.scenario,
    conversation: update.kind === 'conversation' ? merged : current.conversation,
    overallStatus: 'missing',
  };
  ledger.overallStatus = computeBadcaseEvidenceOverallStatus(ledger);
  return ledger;
}

export function getLatestBadcaseEvidence(
  ledger: BadcaseEvidenceLedger,
  kind: BadcaseEvidenceKind,
): BadcaseEvidenceEntry | undefined {
  return latestEntry(kind === 'scenario' ? ledger.scenario : ledger.conversation);
}

function isBadcaseEvidenceEntry(value: unknown): value is BadcaseEvidenceEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<BadcaseEvidenceEntry>;
  return (
    (entry.kind === 'scenario' || entry.kind === 'conversation') &&
    typeof entry.batchId === 'string' &&
    Array.isArray(entry.assetIds) &&
    Array.isArray(entry.executionIds) &&
    (entry.reviewStatus === 'passed' ||
      entry.reviewStatus === 'failed' ||
      entry.reviewStatus === 'pending')
  );
}

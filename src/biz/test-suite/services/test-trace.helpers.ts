import type {
  MemoryAssertions,
  MemoryFixtureSetup,
  TestSourceTrace,
} from '../types/test-debug-trace.types';

type TraceLike = Partial<TestSourceTrace> & {
  sourceBadCaseIds?: string[];
  sourceGoodCaseIds?: string[];
  sourceRecordIds?: string[];
  sourceChatIds?: string[];
  sourceAnchorMessageIds?: string[];
  sourceRelatedMessageIds?: string[];
  sourceMessageProcessingIds?: string[];
  sourceTraceIds?: string[];
  sourceExecutionIds?: string[];
  sourceBatchIds?: string[];
  sourceTrace?: TestSourceTrace;
};

export function normalizeIdList(values?: unknown): string[] {
  if (values === undefined || values === null) return [];

  const parts = Array.isArray(values)
    ? values.flatMap((value) => normalizeIdList(value))
    : String(values)
        .split(/[\s,，;；|]+/)
        .map((value) => value.trim())
        .filter(Boolean);

  return Array.from(new Set(parts));
}

export function normalizeSourceTrace(input?: TraceLike | null): TestSourceTrace | null {
  if (!input) return null;

  const nested = input.sourceTrace ?? {};
  const trace: TestSourceTrace = {
    badcaseIds: mergeIds(nested.badcaseIds, input.badcaseIds, input.sourceBadCaseIds),
    goodcaseIds: mergeIds(nested.goodcaseIds, input.goodcaseIds, input.sourceGoodCaseIds),
    badcaseRecordIds: mergeIds(
      nested.badcaseRecordIds,
      input.badcaseRecordIds,
      input.sourceRecordIds,
    ),
    chatIds: mergeIds(nested.chatIds, input.chatIds, input.sourceChatIds),
    anchorMessageIds: mergeIds(
      nested.anchorMessageIds,
      input.anchorMessageIds,
      input.sourceAnchorMessageIds,
    ),
    relatedMessageIds: mergeIds(
      nested.relatedMessageIds,
      input.relatedMessageIds,
      input.sourceRelatedMessageIds,
    ),
    messageProcessingIds: mergeIds(
      nested.messageProcessingIds,
      input.messageProcessingIds,
      input.sourceMessageProcessingIds,
    ),
    traceIds: mergeIds(nested.traceIds, input.traceIds, input.sourceTraceIds),
    executionIds: mergeIds(nested.executionIds, input.executionIds, input.sourceExecutionIds),
    batchIds: mergeIds(nested.batchIds, input.batchIds, input.sourceBatchIds),
    notes: mergeIds(nested.notes, input.notes),
    raw: mergeRaw(nested.raw, input.raw),
  };

  return compactTrace(trace);
}

export function stringifyTraceJson(value?: unknown): string | null {
  if (value === undefined || value === null) return null;
  const compacted = compactUnknown(value);
  if (compacted === undefined || compacted === null) return null;
  return JSON.stringify(compacted, null, 2);
}

export function parseJsonObject(value?: string | null): Record<string, unknown> | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function coerceMemorySetup(value?: unknown): MemoryFixtureSetup | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as MemoryFixtureSetup)
    : null;
}

export function coerceMemoryAssertions(value?: unknown): MemoryAssertions | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as MemoryAssertions)
    : null;
}

function mergeIds(...values: unknown[]): string[] | undefined {
  const merged = normalizeIdList(values.flatMap((value) => normalizeIdList(value)));
  return merged.length > 0 ? merged : undefined;
}

function mergeRaw(
  left?: Record<string, unknown>,
  right?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const merged = compactUnknown({ ...(left ?? {}), ...(right ?? {}) });
  return merged && typeof merged === 'object' && !Array.isArray(merged)
    ? (merged as Record<string, unknown>)
    : undefined;
}

function compactTrace(trace: TestSourceTrace): TestSourceTrace | null {
  const compacted = compactUnknown(trace);
  if (!compacted || typeof compacted !== 'object' || Array.isArray(compacted)) return null;
  return Object.keys(compacted).length > 0 ? (compacted as TestSourceTrace) : null;
}

function compactUnknown(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    const items = value.map((item) => compactUnknown(item)).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, entryValue]) => [key, compactUnknown(entryValue)] as const)
    .filter(([, entryValue]) => {
      if (entryValue === undefined || entryValue === null) return false;
      if (Array.isArray(entryValue) && entryValue.length === 0) return false;
      if (
        typeof entryValue === 'object' &&
        !Array.isArray(entryValue) &&
        Object.keys(entryValue as Record<string, unknown>).length === 0
      ) {
        return false;
      }
      return true;
    });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

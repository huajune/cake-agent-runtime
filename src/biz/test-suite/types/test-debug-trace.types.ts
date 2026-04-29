/**
 * Test-suite trace contracts.
 *
 * These shapes are intentionally owned by the test-suite layer. They preserve
 * badcase lineage, replay scope, Agent runtime breadcrumbs, and memory fixtures
 * without adding test-only branches to the production Agent path.
 */

export interface TestSourceTrace {
  /** BadCase table stable IDs, e.g. gm33uxr0. */
  badcaseIds?: string[];
  /** GoodCase table stable IDs used as positive references. */
  goodcaseIds?: string[];
  /** Raw Feishu record IDs of the original BadCase / feedback rows. */
  badcaseRecordIds?: string[];
  /** Source chat/session IDs from production evidence. */
  chatIds?: string[];
  /** Triggering user message IDs, usually anchor.messageId from badcase context. */
  anchorMessageIds?: string[];
  /** Message IDs involved in merge/replay or visual evidence. */
  relatedMessageIds?: string[];
  /** Message-processing record IDs when available. */
  messageProcessingIds?: string[];
  /** Agent/runtime trace IDs when available. */
  traceIds?: string[];
  /** Prior test execution IDs that generated or reproduced the case. */
  executionIds?: string[];
  /** Prior batch IDs related to this asset. */
  batchIds?: string[];
  /** Free-form notes useful during curation/debugging. */
  notes?: string[];
  /** Last-resort raw payload for evidence not yet modeled above. */
  raw?: Record<string, unknown>;
}

export interface MemoryFixtureSetup {
  /** Alias of sessionFacts; kept for concise authored fixtures. */
  facts?: Record<string, unknown>;
  /** EntityExtractionResult-compatible session facts. */
  sessionFacts?: Record<string, unknown>;
  lastCandidatePool?: Record<string, unknown>[];
  presentedJobs?: Record<string, unknown>[];
  currentFocusJob?: Record<string, unknown> | null;
  invitedGroups?: Record<string, unknown>[];
  /** Long-term user profile fixture. */
  profile?: Record<string, unknown>;
  /** Convenience stage field. */
  currentStage?: string | null;
  /** ProceduralState-compatible fixture. */
  procedural?: Record<string, unknown>;
}

export interface MemoryAssertions {
  /** Expected long-term memory fragments, e.g. profile fields. */
  longTerm?: Record<string, unknown>;
  /** Expected session facts after the turn. */
  sessionFacts?: Record<string, unknown>;
  /** Expected procedural memory fragments after the turn. */
  procedural?: Record<string, unknown>;
  /** Requires persisted traces to retain sourceTrace evidence. */
  sourceTraceRequired?: boolean;
  /** Memory keys that should survive the turn. */
  shouldPreserve?: string[];
  /** Source BadCase IDs expected in trace-linked memory assertions. */
  sourceBadcaseIds?: string[];
  /** Source anchor message IDs expected in trace-linked memory assertions. */
  sourceAnchorMessageIds?: string[];
  [key: string]: unknown;
}

export interface TestRuntimeScope {
  corpId: string;
  userId: string;
  sessionId: string;
  callerKind: string;
  strategySource?: string;
  scenario?: string;
}

export interface TestExecutionTraceBundle {
  schemaVersion: 1;
  sourceTrace?: TestSourceTrace | null;
  asset: {
    batchId?: string;
    caseId?: string;
    caseName?: string;
    category?: string;
    feishuRecordId?: string;
    conversationSnapshotId?: string;
    validationTitle?: string | null;
    turnNumber?: number;
  };
  runtime: TestRuntimeScope & {
    messageId?: string;
    historyMessageIds?: string[];
    startedAt: string;
    completedAt?: string;
    durationMs?: number;
  };
  agent?: {
    modelId?: string;
    memorySnapshot?: unknown;
    toolCalls?: unknown[];
    steps?: unknown[];
    usage?: unknown;
  };
}

export interface TestMemoryTraceBundle {
  schemaVersion: 1;
  scope: TestRuntimeScope;
  setup?: MemoryFixtureSetup | null;
  assertions?: MemoryAssertions | null;
  entrySnapshot?: unknown;
  postTurnState?: unknown;
  turnEnd?: {
    status: 'completed' | 'failed' | 'skipped';
    durationMs?: number;
    error?: string;
  };
}

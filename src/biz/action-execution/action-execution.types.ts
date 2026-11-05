import type {
  ActionEvidenceKind,
  ActionExecutionStatus,
  ActionMode,
  ActionState,
  LocalSyncState,
} from '@shared-types/action-execution.contract';
import { ACTION_STATE } from '@shared-types/action-execution.contract';
export type {
  ActionMode,
  ActionState,
  LocalSyncState,
} from '@shared-types/action-execution.contract';

export interface ActionIntent {
  corpId: string;
  accountId: string;
  chatId: string;
  logicalTurnId: string;
  /** Stable, validated intent version; normally the persisted logical turn ID. */
  intentId: string;
  /** Registry extension key; built-in callers use ACTION_KIND from the shared contract. */
  kind: string;
  /** Conflict domain, e.g. work-order:123 (shared by cancel and modify). */
  target: string;
  parameters: Record<string, unknown>;
  /** Original input/task time. Never replace with retry time. */
  occurredAt: string;
  /** Frozen scheduled dispatch window; retries must reuse it, never move it to now. */
  recoveryWindowStartedAt?: string;
  /** Only true after the input membership / task identity has been durably established. */
  identityReliable?: boolean;
  /** Minimal local repair input; credentials must be resolved at recovery time. */
  recovery?: Record<string, unknown>;
}

export interface ActionEvidence {
  kind: ActionEvidenceKind;
  externalId?: string;
  goalSatisfied?: boolean;
  /** An authoritative terminal response, not merely a current-state observation. */
  requestTerminated: boolean;
  detail?: string;
}

export type ActionCompletion<T> =
  | { status: typeof ACTION_STATE.SUCCEEDED; result: T; evidence: ActionEvidence }
  | { status: typeof ACTION_STATE.FAILED; result?: T; evidence: ActionEvidence; retryable: boolean }
  | {
      status: typeof ACTION_STATE.UNKNOWN | typeof ACTION_STATE.EXECUTING;
      result?: T;
      evidence: ActionEvidence;
    };

export interface ActionExecution<T> {
  actionId: string;
  requestId: string;
  status: ActionExecutionStatus;
  result?: T;
  evidence?: ActionEvidence;
  localSync: LocalSyncState;
  /** False for replay of an existing completion. */
  dispatched: boolean;
  reason?: string;
}

export interface ActionCallbacks<T> {
  /** Must return immediately after the external result, before local writeback. */
  dispatch: (requestId: string, mode?: ActionMode) => Promise<ActionCompletion<T>>;
  /** Idempotent and version-aware local projection only. Never call the external action. */
  sync?: (result: T) => Promise<void>;
  /** Recheck hosting/permissions/freshness at the actual dispatch boundary. */
  authorize?: () => Promise<boolean>;
}

export interface ActionRecord {
  actionId: string;
  /** Immutable audit predecessor in the same enterprise/resource, not dispatch permission. */
  previousActionId?: string | null;
  requestId: string;
  intent: ActionIntent;
  payloadHash: string;
  mode: ActionMode;
  status: ActionState;
  localSync: LocalSyncState;
  owner: string | null;
  dispatchAttemptId?: string | null;
  fence: number;
  attempts: number;
  result: unknown;
  evidence?: ActionEvidence;
  retryable: boolean;
  nextCheckAt: string | null;
  recoveryDeadline: string;
  reviewRequired: boolean;
}

export interface ActionSyncContext {
  /** Check before every local write; losing the lease leaves local_sync pending. */
  assertOwned: () => Promise<void>;
}

export interface ActionRecoveryHandler {
  /** Query only. No automatic resend without a separately verified provider contract. */
  reconcile: (record: ActionRecord) => Promise<ActionCompletion<unknown>>;
  sync?: (record: ActionRecord, context?: ActionSyncContext) => Promise<void>;
}

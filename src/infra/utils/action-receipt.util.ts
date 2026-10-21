import { asRecord } from './object.util';
import { toErrorMessage } from './error.util';
import type { ToolReplayEvidence, ToolReplayStatus } from '@shared-types/tool-replay.types';
import type { AgentError } from '@shared-types/agent-error.types';

const ACTION_STATUSES = new Set([
  'pending',
  'executing',
  'unknown',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
]);
export type ReceiptActionStatus = ToolReplayStatus | 'failed';

/** Only the shared machine fields count. Prose and outer success flags are not action evidence. */
export function actionReceiptStatuses(result: unknown): ReceiptActionStatus[] {
  const root = asRecord(result);
  if (!root) return [];
  return [root, asRecord(root.groupInvite)]
    .map((item) => item?.actionStatus)
    .filter(
      (status): status is ReceiptActionStatus =>
        typeof status === 'string' && ACTION_STATUSES.has(status),
    );
}

/** Unknown/blocked never mean success, but generic retries cannot grant new permission. */
export function actionReplayStatus(result: unknown): ToolReplayStatus | undefined {
  const statuses = actionReceiptStatuses(result);
  return (['unknown', 'executing', 'pending', 'blocked', 'cancelled', 'succeeded'] as const).find(
    (status) => statuses.includes(status),
  );
}

export function hasReplayEvidence(error: unknown): boolean {
  return Boolean((error as AgentError | null)?.agentMeta?.replayBlockedBy?.length);
}

/** Preserve action evidence through local rendering/review/telemetry failures as well as provider errors. */
export function attachReplayEvidence(error: unknown, evidence: ToolReplayEvidence[]): unknown {
  if (evidence.length === 0) return error;
  let enriched: AgentError;
  if (error instanceof Error) enriched = error;
  else enriched = new Error(toErrorMessage(error));
  const combined = [...(enriched.agentMeta?.replayBlockedBy ?? []), ...evidence];
  const unique = new Map(
    combined.map((item) => [`${item.toolName}:${item.toolCallId ?? ''}:${item.status}`, item]),
  );
  enriched.isAgentError = true;
  enriched.agentMeta = { ...enriched.agentMeta, replayBlockedBy: [...unique.values()] };
  return enriched;
}

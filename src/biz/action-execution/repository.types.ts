import type {
  ActionEvidence,
  ActionIntent,
  ActionMode,
  ActionState,
  LocalSyncState,
} from './action-execution.types';

export interface ActionDbRecord {
  corp_id: string;
  action_id: string;
  previous_action_id?: string | null;
  request_id: string;
  resource_hash: string;
  intent: ActionIntent;
  payload_hash: string;
  mode: ActionMode;
  status: ActionState;
  local_sync: LocalSyncState;
  owner: string | null;
  dispatch_attempt_id: string | null;
  fence: number;
  attempts: number;
  result: unknown;
  evidence: ActionEvidence | null;
  retryable: boolean;
  next_check_at: string | null;
  recovery_deadline: string;
  review_required: boolean;
  created_at: string;
}

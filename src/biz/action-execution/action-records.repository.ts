import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import type {
  ActionCompletion,
  ActionIntent,
  ActionMode,
  ActionRecord,
  ReplySegmentFence,
} from './action-execution.types';
import type { ActionDbRecord } from './repository.types';
import { actionDigest, identifyAction } from './action-identity';
import { ACTION_RECORD_OPERATION } from '@biz/action-execution/action-records.constants';
import {
  ACTION_MODE,
  ACTION_STATE,
  LOCAL_SYNC_STATE,
} from '@shared-types/action-execution.contract';
import type { ActionRecordOperation } from './action-records.constants';

@Injectable()
export class ActionRecordsRepository extends BaseRepository {
  protected readonly tableName = 'agent_action_records';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  async prepare(
    intent: ActionIntent,
    mode: ActionMode,
    replyClaim?: { turn: ReplySegmentFence; owner: string; inspectOnly: boolean },
  ): Promise<{ record: ActionRecord | null; conflict?: string; dispatchUntil?: string }> {
    const identity = identifyAction(intent);
    const operation = replyClaim?.inspectOnly
      ? ACTION_RECORD_OPERATION.INSPECT
      : ACTION_RECORD_OPERATION.CLAIM;
    return this.transition(
      replyClaim ? operation : ACTION_RECORD_OPERATION.PREPARE,
      {
        ...(replyClaim && { owner: replyClaim.owner }),
        ...identity,
        corpId: intent.corpId,
        intent,
        mode,
        resourceHash: actionDigest([intent.corpId, intent.target]),
        recoveryDeadline: new Date(
          Date.parse(intent.occurredAt) + 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
      replyClaim?.turn,
    );
  }

  async claim(record: ActionRecord, owner: string, recovery = false): Promise<ActionRecord | null> {
    const result = await this.transition(
      recovery ? ACTION_RECORD_OPERATION.RECONCILE_CLAIM : ACTION_RECORD_OPERATION.CLAIM,
      {
        corpId: record.intent.corpId,
        actionId: record.actionId,
        owner,
      },
    );
    if (result.conflict || result.record?.owner !== owner) return null;
    return result.record;
  }

  async settle<T>(record: ActionRecord, completion: ActionCompletion<T>): Promise<ActionRecord> {
    this.requireDispatchAttemptId(record);
    const result = await this.transition(ACTION_RECORD_OPERATION.SETTLE, {
      ...this.ownership(record),
      completion,
    });
    if (!result.record) throw new Error('Action disappeared during settlement');
    return result.record;
  }

  async validateClaim(record: ActionRecord): Promise<boolean> {
    const dispatchAttemptId = this.requireDispatchAttemptId(record);
    const result = await this.transition(
      ACTION_RECORD_OPERATION.VALIDATE_CLAIM,
      this.ownership(record),
    );
    return (
      result.record?.owner === record.owner &&
      result.record.dispatchAttemptId === dispatchAttemptId &&
      result.record.fence === record.fence &&
      result.record.status === ACTION_STATE.EXECUTING &&
      Boolean(result.record.nextCheckAt) &&
      Date.parse(result.record.nextCheckAt!) > Date.now()
    );
  }

  async markSynced(record: ActionRecord): Promise<void> {
    const result = await this.transition(ACTION_RECORD_OPERATION.SYNCED, this.ownership(record));
    if (result.record?.localSync !== LOCAL_SYNC_STATE.COMPLETE)
      throw new Error('Local sync ownership changed');
  }

  async cancel(record: ActionRecord): Promise<boolean> {
    const result = await this.transition(ACTION_RECORD_OPERATION.CANCEL, this.ownership(record));
    return result.record?.status === ACTION_STATE.CANCELLED;
  }

  async defer(record: ActionRecord, nextCheckAt: string | null): Promise<void> {
    await this.transition(
      nextCheckAt ? ACTION_RECORD_OPERATION.SCHEDULE : ACTION_RECORD_OPERATION.MANUAL,
      {
        ...this.ownership(record),
        nextCheckAt,
      },
    );
  }

  async due(limit = 25): Promise<ActionRecord[]> {
    if (this.circuitBlocked('action_due')) throw new Error('Action recovery store unavailable');
    const { data, error } = await this.getClient()
      .from(this.tableName)
      .select('*')
      .eq('mode', ACTION_MODE.EXECUTE)
      .lte('next_check_at', new Date().toISOString())
      .or(
        `status.in.(${ACTION_STATE.EXECUTING},${ACTION_STATE.UNKNOWN}),and(status.eq.${ACTION_STATE.SUCCEEDED},local_sync.eq.${LOCAL_SYNC_STATE.PENDING})`,
      )
      .order('next_check_at')
      .order('corp_id')
      .order('action_id')
      .limit(Math.min(limit, 25))
      .abortSignal(AbortSignal.timeout(5000));
    if (error) {
      this.noteOutcome('action_due', error);
      throw error;
    }
    this.recordCircuitSuccess('action_due');
    return (data as ActionDbRecord[]).map((row) => this.fromDb(row));
  }

  async hasNewerCompletion(record: ActionRecord): Promise<boolean> {
    const { data, error } = await this.getClient()
      .from(this.tableName)
      .select('action_id')
      .eq('corp_id', record.intent.corpId)
      .eq('resource_hash', actionDigest([record.intent.corpId, record.intent.target]))
      .eq('status', ACTION_STATE.SUCCEEDED)
      .neq('action_id', record.actionId)
      .gt('input_occurred_at', record.intent.occurredAt)
      .limit(1)
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw error;
    return Boolean(data?.length);
  }

  async terminalEvidence(
    record: ActionRecord,
  ): Promise<{ completion?: ActionCompletion<unknown>; conflicting: boolean }> {
    const dispatchAttemptId = this.requireDispatchAttemptId(record);
    const { data, error } = await this.getClient()
      .rpc('action_terminal_evidence', {
        p_corp: record.intent.corpId,
        p_action: record.actionId,
        p_attempt: dispatchAttemptId,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw error;
    if (!data || typeof data.conflicting !== 'boolean')
      throw new Error('Invalid action evidence response');
    return data;
  }

  async redactCompleted(limit = 100): Promise<number> {
    if (this.circuitBlocked('action_retention'))
      throw new Error('Action retention store unavailable');
    const { data, error } = await this.getClient()
      .rpc('redact_completed_agent_actions', { p_limit: limit })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) {
      this.noteOutcome('action_retention', error);
      throw error;
    }
    this.recordCircuitSuccess('action_retention');
    if (!Number.isSafeInteger(data) || data < 0 || data > limit)
      throw new Error('Invalid action retention count');
    return data;
  }

  private ownership(record: ActionRecord): Record<string, unknown> {
    return {
      corpId: record.intent.corpId,
      actionId: record.actionId,
      owner: record.owner,
      fence: record.fence,
      dispatchAttemptId: record.dispatchAttemptId,
    };
  }

  private requireDispatchAttemptId(record: ActionRecord): string {
    if (typeof record.dispatchAttemptId !== 'string' || !record.dispatchAttemptId.trim())
      throw new Error('Original action dispatch attempt is required');
    return record.dispatchAttemptId;
  }

  private async transition(
    operation: ActionRecordOperation,
    input: Record<string, unknown>,
    turn?: ReplySegmentFence,
  ): Promise<{ record: ActionRecord | null; conflict?: string; dispatchUntil?: string }> {
    if (this.circuitBlocked('action_transition')) throw new Error('Action store unavailable');
    const scope = turn && {
      corpId: turn.corpId,
      accountId: turn.accountId,
      chatId: turn.chatId,
      logicalTurnId: turn.logicalTurnId,
      owner: turn.owner,
      fence: turn.fence,
    };
    const { data, error } = await this.getClient()
      .rpc(turn ? 'transition_agent_reply_segment' : 'transition_agent_action', {
        ...(scope && { p_turn: scope }),
        p_operation: operation,
        p_input: input,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) {
      this.noteOutcome('action_transition', error);
      throw error;
    }
    this.recordCircuitSuccess('action_transition');
    if (!data) throw new Error(`Action ${operation} was not confirmed`);
    return {
      record: data.record ? this.fromDb(data.record) : null,
      conflict: data.conflict ?? undefined,
      dispatchUntil: data.dispatchUntil,
    };
  }

  private fromDb(row: ActionDbRecord): ActionRecord {
    return {
      actionId: row.action_id,
      previousActionId: row.previous_action_id ?? null,
      requestId: row.request_id,
      intent: row.intent,
      payloadHash: row.payload_hash,
      mode: row.mode,
      status: row.status,
      localSync: row.local_sync,
      owner: row.owner,
      dispatchAttemptId: row.dispatch_attempt_id,
      fence: row.fence,
      attempts: row.attempts,
      result: row.result,
      evidence: row.evidence ?? undefined,
      retryable: row.retryable,
      nextCheckAt: row.next_check_at,
      recoveryDeadline: row.recovery_deadline,
      reviewRequired: row.review_required,
    };
  }
}

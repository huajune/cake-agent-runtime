import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import type {
  ActionCompletion,
  ActionIntent,
  ActionMode,
  ActionRecord,
} from './action-execution.types';
import type { ActionDbRecord } from './repository.types';
import { actionDigest, identifyAction } from './action-identity';

@Injectable()
export class ActionRecordsRepository extends BaseRepository {
  protected readonly tableName = 'agent_action_records';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  async prepare(
    intent: ActionIntent,
    mode: ActionMode,
  ): Promise<{ record: ActionRecord | null; conflict?: string }> {
    const identity = identifyAction(intent);
    return this.transition('prepare', {
      ...identity,
      corpId: intent.corpId,
      intent,
      mode,
      resourceHash: actionDigest([intent.corpId, intent.target]),
      recoveryDeadline: new Date(
        Date.parse(intent.recoveryWindowStartedAt ?? intent.occurredAt) + 24 * 60 * 60 * 1000,
      ).toISOString(),
    });
  }

  async claim(record: ActionRecord, owner: string, recovery = false): Promise<ActionRecord | null> {
    const result = await this.transition(recovery ? 'reconcile_claim' : 'claim', {
      corpId: record.intent.corpId,
      actionId: record.actionId,
      owner,
    });
    if (result.conflict || result.record?.owner !== owner) return null;
    return result.record;
  }

  async settle<T>(record: ActionRecord, completion: ActionCompletion<T>): Promise<ActionRecord> {
    const result = await this.transition('settle', {
      ...this.ownership(record),
      completion,
      evidenceHash: actionDigest(completion),
    });
    if (!result.record) throw new Error('Action disappeared during settlement');
    return result.record;
  }

  async validateClaim(record: ActionRecord): Promise<boolean> {
    const result = await this.transition('validate_claim', this.ownership(record));
    return (
      result.record?.owner === record.owner &&
      result.record.fence === record.fence &&
      result.record.status === 'executing' &&
      Boolean(result.record.nextCheckAt) &&
      Date.parse(result.record.nextCheckAt!) > Date.now()
    );
  }

  async markSynced(record: ActionRecord): Promise<void> {
    const result = await this.transition('synced', this.ownership(record));
    if (result.record?.localSync !== 'complete') throw new Error('Local sync ownership changed');
  }

  async cancel(record: ActionRecord): Promise<boolean> {
    const result = await this.transition('cancel', this.ownership(record));
    return result.record?.status === 'cancelled';
  }

  async defer(record: ActionRecord, nextCheckAt: string | null): Promise<void> {
    await this.transition(nextCheckAt ? 'schedule' : 'manual', {
      ...this.ownership(record),
      nextCheckAt,
    });
  }

  async due(limit = 25): Promise<ActionRecord[]> {
    if (this.circuitBlocked('action_due')) throw new Error('Action recovery store unavailable');
    const { data, error } = await this.getClient()
      .from(this.tableName)
      .select('*')
      .eq('mode', 'execute')
      .lte('next_check_at', new Date().toISOString())
      .or('status.in.(executing,unknown),and(status.eq.succeeded,local_sync.eq.pending)')
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
      .eq('status', 'succeeded')
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
    const { data, error } = await this.getClient()
      .from('agent_action_evidence')
      .select('completion')
      .eq('corp_id', record.intent.corpId)
      .eq('action_id', record.actionId)
      .eq('attempt_id', record.dispatchAttemptId ?? record.owner ?? '')
      .order('created_at', { ascending: false })
      .limit(20)
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw error;
    const completions = (data ?? [])
      .map((row) => row.completion as ActionCompletion<unknown>)
      .filter(
        (completion) =>
          completion.evidence.requestTerminated &&
          (completion.status === 'succeeded' ||
            (completion.status === 'failed' &&
              completion.evidence.kind === 'definitive_no_effect')),
      );
    const successes = completions.filter((completion) => completion.status === 'succeeded');
    return {
      completion: successes[0] ?? completions[0],
      conflicting:
        successes.length > 0 && completions.some((completion) => completion.status === 'failed'),
    };
  }

  async redactCompleted(): Promise<void> {
    if (this.circuitBlocked('action_retention'))
      throw new Error('Action retention store unavailable');
    const { error } = await this.getClient()
      .rpc('redact_completed_agent_actions', { p_limit: 100 })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) {
      this.noteOutcome('action_retention', error);
      throw error;
    }
    this.recordCircuitSuccess('action_retention');
  }

  private ownership(record: ActionRecord): Record<string, unknown> {
    return {
      corpId: record.intent.corpId,
      actionId: record.actionId,
      owner: record.owner,
      fence: record.fence,
      dispatchAttemptId: record.dispatchAttemptId ?? record.owner,
    };
  }

  private async transition(
    operation: string,
    input: Record<string, unknown>,
  ): Promise<{ record: ActionRecord | null; conflict?: string }> {
    if (this.circuitBlocked('action_transition')) throw new Error('Action store unavailable');
    const { data, error } = await this.getClient()
      .rpc('transition_agent_action', {
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

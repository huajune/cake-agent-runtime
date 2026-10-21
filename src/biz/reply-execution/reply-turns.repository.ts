import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import type { ReplyTurn } from './reply-execution.types';

@Injectable()
export class ReplyTurnsRepository extends BaseRepository {
  protected readonly tableName = 'agent_reply_turns';
  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  async transition(operation: string, input: Record<string, unknown>): Promise<ReplyTurn | null> {
    if (this.circuitBlocked('reply_turn')) throw new Error('reply_store_unavailable');
    const { data, error } = await this.getClient()
      .rpc('transition_agent_reply_turn', {
        p_operation: operation,
        p_input: input,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) {
      this.noteOutcome('reply_turn', error);
      throw error;
    }
    this.recordCircuitSuccess('reply_turn');
    if (!data || data.conflict) throw new Error(data?.conflict ?? 'reply_transition_unconfirmed');
    return data.turn ? this.fromDb(data.turn) : null;
  }

  async due(): Promise<ReplyTurn[]> {
    const { data, error } = await this.getClient()
      .from(this.tableName)
      .select('*')
      .eq('mode', 'execute')
      .not('recovery->primary', 'is', null)
      .in('status', ['preparing', 'planned', 'settled'])
      .lte('next_check_at', new Date().toISOString())
      .order('next_check_at')
      .limit(25)
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw error;
    return (data ?? []).map((row) => this.fromDb(row));
  }

  async appendCallback(input: {
    corpId: string;
    accountId: string;
    chatId: string;
    requestId: string;
    messageId: string;
    text: string;
    messageType: number;
    payload: Record<string, unknown>;
  }): Promise<boolean> {
    const { data, error } = await this.getClient()
      .rpc('append_agent_reply_callback', { p_input: input })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw error;
    return data === true;
  }

  async dueTaskProjections(): Promise<ReplyTurn[]> {
    const { data, error } = await this.getClient()
      .from(this.tableName)
      .select('*')
      .eq('mode', 'execute')
      .eq('projection_status', 'pending')
      .eq('recovery->task->>kind', 'reengagement')
      .lte('projection_next_check_at', new Date().toISOString())
      .order('projection_next_check_at')
      .limit(25)
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw error;
    return (data ?? []).map((row) => this.fromDb(row));
  }

  async redact(): Promise<void> {
    const { error } = await this.getClient()
      .rpc('redact_completed_agent_reply_turns', { p_limit: 100 })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw error;
  }

  async confirmed(turn: ReplyTurn): Promise<boolean> {
    const { data, error } = await this.getClient()
      .rpc('agent_reply_plan_confirmed', {
        p_corp_id: turn.corpId,
        p_turn_id: turn.logicalTurnId,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw error;
    return data === true;
  }

  private fromDb(row: Record<string, unknown>): ReplyTurn {
    return {
      corpId: row.corp_id as string,
      accountId: row.account_id as string,
      chatId: row.chat_id as string,
      logicalTurnId: row.logical_turn_id as string,
      inputIds: row.input_ids as string[],
      inputOccurredAt: row.input_occurred_at as string,
      mode: row.mode as ReplyTurn['mode'],
      status: row.status as ReplyTurn['status'],
      owner: row.owner as string | null,
      fence: row.fence as number,
      plan: row.plan as ReplyTurn['plan'],
      recovery: row.recovery as Record<string, unknown>,
      projectionStatus: row.projection_status as ReplyTurn['projectionStatus'],
    };
  }
}

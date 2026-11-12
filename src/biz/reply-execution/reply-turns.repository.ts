import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import type { ReplyTurn } from './reply-execution.types';
import {
  isReplyDeliveryPolicy,
  REPLY_TURN_STATUS,
} from '@biz/reply-execution/reply-execution.constants';
import { ACTION_MODE } from '@shared-types/action-execution.contract';
import type { ReplyTurnOperation } from './reply-execution.constants';

@Injectable()
export class ReplyTurnsRepository extends BaseRepository {
  protected readonly tableName = 'agent_reply_turns';
  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  async transition(
    operation: ReplyTurnOperation,
    input: Record<string, unknown>,
  ): Promise<ReplyTurn | null> {
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
      .eq('mode', ACTION_MODE.EXECUTE)
      .not('recovery->primary', 'is', null)
      .in('status', [
        REPLY_TURN_STATUS.PREPARING,
        REPLY_TURN_STATUS.PLANNED,
        REPLY_TURN_STATUS.SETTLED,
      ])
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

  async redact(limit = 100): Promise<number> {
    const { data, error } = await this.getClient()
      .rpc('redact_completed_agent_reply_turns', { p_limit: limit })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw error;
    if (!Number.isSafeInteger(data) || data < 0 || data > limit)
      throw new Error('Invalid reply retention count');
    return data;
  }

  private fromDb(row: Record<string, unknown>): ReplyTurn {
    if (!isReplyDeliveryPolicy(row.delivery_policy))
      throw new Error('reply_delivery_policy_schema_unconfirmed');
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
      deliveryPolicy: row.delivery_policy as ReplyTurn['deliveryPolicy'],
      deliveryResult: row.delivery_result as ReplyTurn['deliveryResult'],
      recovery: row.recovery as Record<string, unknown>,
      projectionStatus: row.projection_status as ReplyTurn['projectionStatus'],
    };
  }
}

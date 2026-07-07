import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import type { AgentExecutionEvent } from '@observability/persistence/agent-event-persister.interface';

interface AgentExecutionEventDbRecord {
  id: number;
  trace_id: string | null;
  event_type: string;
  user_id: string | null;
  corp_id: string | null;
  chat_id: string | null;
  scenario: string | null;
  caller_kind: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

@Injectable()
export class AgentExecutionEventRepository extends BaseRepository {
  protected readonly tableName = 'agent_execution_events';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  async saveEvent(event: AgentExecutionEvent): Promise<void> {
    if (!this.isAvailable()) return;

    const inserted = await this.insert<AgentExecutionEventDbRecord>(this.toDbRecord(event), {
      returnData: true,
    });
    if (!inserted) {
      throw new Error('agent_execution_events insert returned no row');
    }
  }

  async cleanupExpiredEvents(retentionDays: number): Promise<number> {
    if (!this.isAvailable()) return 0;

    try {
      const result = await this.rpc<Array<{ deleted_count: string }>>(
        'cleanup_agent_execution_events',
        { days_to_keep: retentionDays },
      );
      return parseInt(result?.[0]?.deleted_count ?? '0', 10);
    } catch (error) {
      this.logger.error(`[Agent执行事件] 清理失败:`, error);
      throw error;
    }
  }

  private toDbRecord(event: AgentExecutionEvent): Partial<AgentExecutionEventDbRecord> {
    const { type, traceId, chatId, userId, corpId, scenario, callerKind, timestamp, ...payload } =
      event;

    return {
      trace_id: traceId ?? null,
      event_type: type,
      user_id: userId ?? null,
      corp_id: corpId ?? null,
      chat_id: chatId ?? null,
      scenario: scenario ?? null,
      caller_kind: callerKind ?? null,
      payload,
      created_at: new Date(timestamp ?? Date.now()).toISOString(),
    };
  }
}

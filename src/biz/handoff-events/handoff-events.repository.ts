import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import type { HandoffWriteOutcome, RecordHandoffInput } from './handoff-events.types';

interface HandoffTicketRow {
  corp_id: string;
  chat_id: string;
  user_id: string | null;
  reason_code: string;
  reason: string | null;
  action_advice: string | null;
  stage: string | null;
  bot_im_id: string | null;
  work_order_id: number | null;
  job_id: number | null;
  missing_job_info: string[] | null;
  idempotency_key: string;
  created_at: string;
}

/**
 * 转人工工单仓储。处理建议、结果与解决时间在工单中维护。
 * 转人工次数及原因分布从 ops_events 的 handoff.triggered 统计。
 */
@Injectable()
export class HandoffEventsRepository extends BaseRepository {
  protected readonly tableName = 'handoff_events';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 在同一事务登记工单和触发事件，并更新日报；重复请求沿用原记录。
   * @returns 三态写入结果：只有 duplicate 可被调用方用于跳过后续派发；failed 应 fail-safe。
   */
  async recordHandoffTicket(
    input: RecordHandoffInput & { occurredAt: Date },
    group?: { managerName: string; groupName: string } | null,
  ): Promise<HandoffWriteOutcome> {
    const payload: HandoffTicketRow = {
      corp_id: input.corpId,
      chat_id: input.chatId,
      user_id: input.userId ?? null,
      reason_code: input.reasonCode,
      reason: input.reason ?? null,
      action_advice: input.actionAdvice ?? null,
      stage: input.stage ?? null,
      bot_im_id: input.botImId ?? null,
      work_order_id: input.workOrderId ?? null,
      job_id: input.jobId ?? null,
      missing_job_info: input.missingJobInfo?.length ? input.missingJobInfo : null,
      idempotency_key: input.idempotencyKey,
      created_at: input.occurredAt.toISOString(),
    };

    const result = await this.rpc<string>('record_handoff', {
      p_ticket: payload,
      p_origin: input.origin ?? 'agent_tool',
      p_manager: group?.managerName ?? null,
      p_group: group?.groupName ?? null,
    });
    if (result === 'scope_conflict') {
      this.logger.error('转人工幂等键与所属账号冲突，已保留原记录');
      return input.requireMatchingScope ? 'failed' : 'duplicate';
    }
    return result === 'inserted' || result === 'duplicate' ? result : 'failed';
  }

  /**
   * 删除超过保留期的转人工工单。触发事实继续保存在 ops_events 中。
   */
  async cleanupExpiredEvents(retentionDays: number): Promise<number> {
    if (!this.isAvailable()) return 0;
    const cutoffIso = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const deleted = await this.delete<{ id: number }>((q) => q.lt('created_at', cutoffIso), true);
    if (deleted.length > 0) {
      this.logger.log(
        `[转人工工单] 清理完成: 删除 ${deleted.length} 行 ${retentionDays} 天前的记录`,
      );
    }
    return deleted.length;
  }

  /**
   * 在原托管暂停的企业、账号和会话范围内关闭符合时间边界的工单。
   * 由托管恢复路径调用；写失败只 warn，不阻断恢复。
   */
  async markResolvedByChat(chatId: string, outcome: string): Promise<number> {
    return (
      (await this.rpc<number>('resolve_hosting_handoffs', {
        p_user: chatId,
        p_outcome: outcome,
      })) ?? 0
    );
  }
}

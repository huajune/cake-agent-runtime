import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import type { HandoffWriteOutcome, RecordHandoffInput } from './handoff-events.types';

interface HandoffEventRow {
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
 * handoff_events 写入侧仓储：转人工触发底账（幂等）。
 *
 * 读取侧（GROUP BY reason_code / stage）由 conversion-analytics 独立查询。
 */
@Injectable()
export class HandoffEventsRepository extends BaseRepository {
  protected readonly tableName = 'handoff_events';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 写入一条转人工底账（幂等：同 corp_id + idempotency_key 跳过）。
   * @returns 三态写入结果：只有 duplicate 可被调用方用于跳过后续派发；failed 应 fail-safe。
   */
  async insertHandoffEvent(
    input: RecordHandoffInput & { occurredAt: Date },
    group?: { managerName: string; groupName: string } | null,
  ): Promise<HandoffWriteOutcome> {
    const payload: HandoffEventRow = {
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
      return 'duplicate';
    }
    return result === 'inserted' || result === 'duplicate' ? result : 'failed';
  }

  /**
   * 删除超过保留期的转人工底账（观测数据统一 90 天）。
   * 业务事实与全部字段永久留在 ops_events(handoff.triggered).payload。
   */
  async cleanupExpiredEvents(retentionDays: number): Promise<number> {
    if (!this.isAvailable()) return 0;
    const cutoffIso = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const deleted = await this.delete<{ id: number }>((q) => q.lt('created_at', cutoffIso), true);
    if (deleted.length > 0) {
      this.logger.log(
        `[转人工底账] 清理完成: 删除 ${deleted.length} 行 ${retentionDays} 天前的记录`,
      );
    }
    return deleted.length;
  }

  /**
   * 回填结果：把该会话所有尚未闭环的转人工记录标记为 outcome（resumed / expired / manual_closed …）。
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

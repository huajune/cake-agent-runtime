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
  sequence_no: number | null;
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
      sequence_no: null,
    };

    if (!this.isAvailable()) {
      this.logger.warn(`Supabase 未初始化，跳过 ${this.tableName} upsert`);
      return 'failed';
    }
    if (this.circuitBlocked('UPSERT')) {
      return 'failed';
    }

    try {
      // 会话内序号（区分"反复转"与"新问题"）：DB 侧取 MAX+1，取不到不阻断写入
      payload.sequence_no = await this.nextSequenceNo(input.corpId, input.chatId);

      // BaseRepository.upsert() returns null for both conflict and failures. This path needs to
      // preserve that distinction for outcome-layer handoff idempotency.
      const { data, error } = await this.getClient()
        .from(this.tableName)
        .upsert(payload as unknown as Record<string, unknown>, {
          onConflict: 'corp_id,idempotency_key',
          ignoreDuplicates: true,
        })
        .select('idempotency_key');

      if (error) {
        this.handleError('UPSERT', error);
        return 'failed';
      }

      const insertedRows = (data as Array<Pick<HandoffEventRow, 'idempotency_key'>> | null) ?? [];
      return insertedRows.length > 0 ? 'inserted' : 'duplicate';
    } catch (error) {
      this.handleError('UPSERT', error);
      return 'failed';
    }
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
    if (!this.isAvailable()) return 0;
    if (this.circuitBlocked('UPDATE')) return 0;
    try {
      const { data, error } = await this.getClient()
        .from(this.tableName)
        .update({ outcome, resolved_at: new Date().toISOString() })
        .eq('chat_id', chatId)
        .is('outcome', null)
        .select('id');
      if (error) {
        this.handleError('UPDATE', error);
        return 0;
      }
      return (data as Array<{ id: number }> | null)?.length ?? 0;
    } catch (error) {
      this.handleError('UPDATE', error);
      return 0;
    }
  }

  private async nextSequenceNo(corpId: string, chatId: string): Promise<number | null> {
    try {
      const result = await this.rpc<number | string>('next_handoff_sequence_no', {
        p_corp_id: corpId,
        p_chat_id: chatId,
      });
      const n = Number(result);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }
}

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
      missing_job_info: input.missingJobInfo?.length ? input.missingJobInfo : null,
      idempotency_key: input.idempotencyKey,
      created_at: input.occurredAt.toISOString(),
    };

    if (!this.isAvailable()) {
      this.logger.warn(`Supabase 未初始化，跳过 ${this.tableName} upsert`);
      return 'failed';
    }
    if (this.circuitBlocked('UPSERT')) {
      return 'failed';
    }

    try {
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
}

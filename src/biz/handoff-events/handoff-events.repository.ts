import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import type { RecordHandoffInput } from './handoff-events.types';

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
   * @returns 是否真正插入（false=重复或失败）。
   */
  async insertHandoffEvent(input: RecordHandoffInput & { occurredAt: Date }): Promise<boolean> {
    // 走 BaseRepository.upsert：受熔断器保护（ignoreDuplicates 命中冲突时返回 null）。
    // 非 null 即真正插入了一行 → true；null = 重复/不可用/熔断/出错 → false。
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
      idempotency_key: input.idempotencyKey,
      created_at: input.occurredAt.toISOString(),
    };

    const row = await this.upsert<HandoffEventRow>(payload, {
      onConflict: 'corp_id,idempotency_key',
      ignoreDuplicates: true,
    });

    return row !== null;
  }
}

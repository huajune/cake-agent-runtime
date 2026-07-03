import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import type {
  CandidateMessageResult,
  OpsEventWriteResult,
  PendingHireWorkOrder,
  RecordCandidateMessageInput,
  RecordOpsEventInput,
} from '../types/ops-events.types';

/**
 * ops_events 写入侧仓储：只调两个 RPC，写底账 + 投影日报全在 PG 内原子完成。
 *
 * - upsert_ops_event：INSERT ops_events（幂等）+ 投影 daily_ops_report
 * - check_and_record_first_engaged：记录候选人消息 + 原子检测首条破冰
 *
 * 读取侧（KPI / cohort / 对比）不走这里，由 conversion-analytics 模块独立查询。
 */
@Injectable()
export class OpsEventsRepository extends BaseRepository {
  protected readonly tableName = 'ops_events';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  private toIso(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : value;
  }

  /**
   * 调 upsert_ops_event。
   * @returns 三态写入结果：inserted（首次插入）/ duplicate（幂等冲突）/ failed（不可用/出错，可重试）。
   */
  async upsertOpsEvent(
    input: RecordOpsEventInput & { occurredAt: Date | string },
  ): Promise<OpsEventWriteResult> {
    // 走 BaseRepository.rpc：受进程级熔断器保护（DB 濒死时快速失败、记录故障），
    // 避免绕过 2026-06-04 事故后加固的熔断逻辑。null = 不可用/熔断/出错 → 'failed'。
    const data = await this.rpc<{ inserted?: boolean }>('upsert_ops_event', {
      p_corp_id: input.corpId,
      p_event_name: input.eventName,
      p_idempotency_key: input.idempotencyKey,
      p_occurred_at: this.toIso(input.occurredAt),
      p_bot_im_id: input.botImId ?? null,
      p_manager_name: input.managerName ?? null,
      p_group_name: input.groupName ?? null,
      p_source_channel: input.sourceChannel ?? null,
      p_user_id: input.userId ?? null,
      p_chat_id: input.chatId ?? null,
      p_payload: input.payload ?? null,
    });

    if (data === null) {
      return 'failed';
    }

    return data.inserted === true ? 'inserted' : 'duplicate';
  }

  /**
   * 调 check_and_record_first_engaged：记录候选人消息并原子检测首条破冰。
   */
  async checkAndRecordFirstEngaged(
    input: RecordCandidateMessageInput & { occurredAt: Date | string },
  ): Promise<CandidateMessageResult> {
    // 同 upsertOpsEvent：走熔断器保护的 BaseRepository.rpc。
    const row = await this.rpc<{ message_recorded?: boolean; engaged?: boolean }>(
      'check_and_record_first_engaged',
      {
        p_corp_id: input.corpId,
        p_chat_id: input.chatId,
        p_message_id: input.messageId,
        p_occurred_at: this.toIso(input.occurredAt),
        p_bot_im_id: input.botImId ?? null,
        p_manager_name: input.managerName ?? null,
        p_group_name: input.groupName ?? null,
        p_source_channel: input.sourceChannel ?? null,
        p_user_id: input.userId ?? null,
        p_payload: input.payload ?? null,
      },
    );

    return {
      messageRecorded: row?.message_recorded === true,
      engaged: row?.engaged === true,
    };
  }

  /**
   * 查待轮询面试结果的工单：window 内 booking.succeeded 但尚未 interview.passed 的工单。
   *
   * 两次 select + 应用层差集（已 pass 的不再轮询）。同一 workOrderId 去重。
   * 注：统计收口到面试通过，不再轮询 / 采集入职（candidate.hired）。
   * @param sinceReportDate YYYY-MM-DD（Asia/Shanghai），window 下界（含）。
   */
  async findWorkOrdersPendingPass(sinceReportDate: string): Promise<PendingHireWorkOrder[]> {
    if (!this.isAvailable()) {
      return [];
    }

    // selectAllPaged 复用熔断器 + 退避重试；modifier 内附带稳定排序（report_date + id），
    // 避免分页跨 1000 行时漏/重。
    const [bookingRows, passedRows] = await Promise.all([
      this.selectAllPaged<{
        corp_id: string;
        user_id?: string | null;
        chat_id?: string | null;
        bot_im_id?: string | null;
        payload?: { work_order_id?: unknown } | null;
      }>(this.tableName, 'corp_id, user_id, chat_id, bot_im_id, payload', (q) =>
        q
          .eq('event_name', 'booking.succeeded')
          .gte('report_date', sinceReportDate)
          .order('report_date', { ascending: true })
          .order('id', { ascending: true }),
      ),
      this.selectAllPaged<{ idempotency_key?: string | null }>(
        this.tableName,
        'idempotency_key',
        (q) =>
          q
            .eq('event_name', 'interview.passed')
            .gte('report_date', sinceReportDate)
            .order('report_date', { ascending: true })
            .order('id', { ascending: true }),
      ),
    ]);

    const passedWorkOrderIds = new Set(
      passedRows.map((row) => String(row.idempotency_key ?? '').replace(/:pass$/, '')),
    );

    const seen = new Set<number>();
    const pending: PendingHireWorkOrder[] = [];
    for (const row of bookingRows) {
      const workOrderId = Number(row.payload?.work_order_id);
      if (!Number.isFinite(workOrderId) || workOrderId <= 0) continue;
      if (passedWorkOrderIds.has(String(workOrderId)) || seen.has(workOrderId)) continue;
      seen.add(workOrderId);
      pending.push({
        workOrderId,
        corpId: row.corp_id,
        userId: row.user_id ?? null,
        chatId: row.chat_id ?? null,
        botImId: row.bot_im_id ?? null,
      });
    }
    return pending;
  }
}

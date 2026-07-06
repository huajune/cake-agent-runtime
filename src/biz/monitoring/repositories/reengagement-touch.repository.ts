import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import {
  RecordReengagementTouchInput,
  ReengagementCandidateFilters,
  ReengagementCandidateOverviewRow,
  ReengagementTouchDbRecord,
  ReengagementTouchFilters,
  ReengagementTouchStatsRow,
} from '../entities/reengagement-touch.entity';

/**
 * 二次触发触达追溯 Repository
 *
 * 写入走 record_reengagement_touch RPC：原子 upsert + events 追加，
 * scheduler 与 processor 并发写同一行不丢事件。读取供 Dashboard 追溯页。
 */
@Injectable()
export class ReengagementTouchRepository extends BaseRepository {
  protected readonly tableName = 'reengagement_touch_records';

  // 列表投影：不拉 generated_text / events 两个大字段
  private readonly summarySelectedColumns = [
    'touch_key',
    'session_id',
    'user_id',
    'corp_id',
    'scenario_code',
    'anchor_at',
    'status',
    'decision_reason',
    'shadow',
    'fire_at',
    'scheduled_at',
    'fired_at',
    'sent_at',
    'outcome_kind',
    'reserve_result',
    'error',
    'created_at',
    'updated_at',
  ].join(',');

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /** 落一次生命周期流转（upsert + 事件追加）。失败只记日志，返回 false。 */
  async record(input: RecordReengagementTouchInput): Promise<boolean> {
    if (!this.isAvailable()) {
      this.logger.warn('[二次触发追溯] Supabase 未初始化，跳过落库');
      return false;
    }
    const toIso = (ts?: number): string | null =>
      ts === undefined ? null : new Date(ts).toISOString();
    const event = input.event
      ? { at: new Date().toISOString(), event: input.event.event, detail: input.event.detail }
      : null;
    const result = await this.rpc<null>('record_reengagement_touch', {
      p_touch_key: input.touchKey,
      p_session_id: input.sessionId ?? null,
      p_user_id: input.userId ?? null,
      p_corp_id: input.corpId ?? null,
      p_scenario_code: input.scenarioCode ?? null,
      p_anchor_event_id: input.anchorEventId ?? null,
      p_anchor_at: toIso(input.anchorAt),
      p_job_id: input.jobId ?? null,
      p_status: input.status ?? null,
      p_decision_reason: input.decisionReason ?? null,
      p_shadow: input.shadow ?? null,
      p_fire_at: toIso(input.fireAt),
      p_scheduled_at: toIso(input.scheduledAt),
      p_fired_at: toIso(input.firedAt),
      p_sent_at: toIso(input.sentAt),
      p_outcome_kind: input.outcomeKind ?? null,
      p_generated_text: input.generatedText ?? null,
      p_reserve_result: input.reserveResult ?? null,
      p_error: input.error ?? null,
      p_event: event,
      p_batch_id: input.batchId ?? null,
      p_candidate_name: input.candidateName ?? null,
      p_manager_name: input.managerName ?? null,
      p_bot_im_id: input.botImId ?? null,
    });
    // RPC RETURNS VOID → data 为 null；错误路径 BaseRepository 已记日志并返回 null，
    // 这里无法区分，仅作 best-effort 观测写入，不影响调用方。
    return result !== undefined;
  }

  /** 分页列表（默认 created_at 倒序） */
  async getRecords(filters: ReengagementTouchFilters): Promise<ReengagementTouchDbRecord[]> {
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;
    return this.select<ReengagementTouchDbRecord>(this.summarySelectedColumns, (q) => {
      let query = q;
      if (filters.startDate) query = query.gte('created_at', filters.startDate);
      if (filters.endDate) query = query.lte('created_at', filters.endDate);
      if (filters.status) query = query.eq('status', filters.status);
      if (filters.scenarioCode) query = query.eq('scenario_code', filters.scenarioCode);
      if (filters.sessionId) query = query.eq('session_id', filters.sessionId);
      return query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    });
  }

  /** 详情（含 generated_text 与 events 全轨迹） */
  async getRecordByTouchKey(touchKey: string): Promise<ReengagementTouchDbRecord | null> {
    return this.selectOne<ReengagementTouchDbRecord>('*', (q) => q.eq('touch_key', touchKey));
  }

  /** 时间范围内按 status + scenario 分组计数（DB 侧聚合） */
  async getStats(startDate: string, endDate: string): Promise<ReengagementTouchStatsRow[]> {
    const rows = await this.rpc<ReengagementTouchStatsRow[]>('get_reengagement_touch_stats', {
      p_start: startDate,
      p_end: endDate,
    });
    return rows ?? [];
  }

  /**
   * 候选人视角：每 (session, scenario) 最新一次触达，按候选人分页（DB 侧 DISTINCT ON + 窗口计数）。
   * 返回行集由服务层按 session 分组组装。
   */
  async getCandidateOverview(
    filters: ReengagementCandidateFilters,
  ): Promise<ReengagementCandidateOverviewRow[]> {
    const rows = await this.rpc<ReengagementCandidateOverviewRow[]>(
      'get_reengagement_candidate_overview',
      {
        p_start: filters.startDate ?? null,
        p_end: filters.endDate ?? null,
        p_scenario_code: filters.scenarioCode ?? null,
        p_session_id: filters.sessionId ?? null,
        p_pending_only: filters.pendingOnly ?? false,
        p_limit: Math.min(filters.limit ?? 50, 200),
        p_offset: filters.offset ?? 0,
      },
    );
    return rows ?? [];
  }
}

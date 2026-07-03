import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import type { DailyOpsReportRow } from '../entities/daily-ops-report.entity';
import type { DailyOpsReportSums } from '../types/ops-events.types';

const EMPTY_SUMS: DailyOpsReportSums = {
  friendsAdded: 0,
  openingSent: 0,
  breakIce: 0,
  candidateMessage: 0,
  agentReply: 0,
  jobRecommend: 0,
  precheckPass: 0,
  bookingSuccess: 0,
  bookingFail: 0,
  groupInvite: 0,
  handoff: 0,
  interviewPass: 0,
  rowCount: 0,
};

const SUM_COLUMNS = [
  'friends_added_count',
  'agent_opening_sent_count',
  'break_ice_count',
  'candidate_message_count',
  'agent_reply_count',
  'job_recommend_count',
  'precheck_pass_count',
  'booking_success_count',
  'booking_fail_count',
  'group_invite_count',
  'handoff_count',
  'interview_pass_count',
].join(',');

/**
 * daily_ops_report 读取仓储（飞书日报 cron 用）。
 *
 * 该表由 upsert_ops_event RPC 投影写入；这里只读。
 */
@Injectable()
export class DailyOpsReportRepository extends BaseRepository {
  protected readonly tableName = 'daily_ops_report';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /** 取某一天（report_date，Asia/Shanghai）全部 bot 的投影行，按小组排序。 */
  async findByReportDate(reportDate: string): Promise<DailyOpsReportRow[]> {
    // selectAllPaged：受熔断器保护 + 翻页拉全（单日 bot 数可能超 1000）；
    // group_name/manager_name 非唯一，补 id 作稳定二级排序，避免分页漏/重。
    return this.selectAllPaged<DailyOpsReportRow>(this.tableName, '*', (q) =>
      q
        .eq('report_date', reportDate)
        .order('group_name', { ascending: true })
        .order('manager_name', { ascending: true })
        .order('id', { ascending: true }),
    );
  }

  /**
   * 汇总某 report_date 范围（含端点，Asia/Shanghai 日期）内全部 bot 的各项计数。
   * 跨所有 corp 汇总（与仪表盘现有口径一致）。
   */
  async sumByDateRange(
    startReportDate: string,
    endReportDate: string,
  ): Promise<DailyOpsReportSums> {
    // selectAllPaged：受熔断器保护 + 翻页拉全；range 分页必须带稳定排序（id），否则跨页漏/重。
    const rows = await this.selectAllPaged<Record<string, number | null>>(
      this.tableName,
      SUM_COLUMNS,
      (q) =>
        q
          .gte('report_date', startReportDate)
          .lte('report_date', endReportDate)
          .order('id', { ascending: true }),
    );

    const sums: DailyOpsReportSums = { ...EMPTY_SUMS };
    for (const row of rows) {
      sums.friendsAdded += row.friends_added_count ?? 0;
      sums.openingSent += row.agent_opening_sent_count ?? 0;
      sums.breakIce += row.break_ice_count ?? 0;
      sums.candidateMessage += row.candidate_message_count ?? 0;
      sums.agentReply += row.agent_reply_count ?? 0;
      sums.jobRecommend += row.job_recommend_count ?? 0;
      sums.precheckPass += row.precheck_pass_count ?? 0;
      sums.bookingSuccess += row.booking_success_count ?? 0;
      sums.bookingFail += row.booking_fail_count ?? 0;
      sums.groupInvite += row.group_invite_count ?? 0;
      sums.handoff += row.handoff_count ?? 0;
      sums.interviewPass += row.interview_pass_count ?? 0;
    }
    sums.rowCount = rows.length;

    return sums;
  }

  /**
   * 按 report_date 汇总预约成功数，供 Dashboard 业务趋势使用。
   */
  async sumBookingSuccessByDateRange(
    startReportDate: string,
    endReportDate: string,
  ): Promise<Array<{ date: string; bookingSuccess: number }>> {
    const rows = await this.selectAllPaged<{
      report_date: string;
      booking_success_count: number | null;
    }>(this.tableName, 'report_date,booking_success_count', (q) =>
      q
        .gte('report_date', startReportDate)
        .lte('report_date', endReportDate)
        .order('report_date', { ascending: true })
        .order('id', { ascending: true }),
    );

    const byDate = new Map<string, number>();
    for (const row of rows) {
      byDate.set(
        row.report_date,
        (byDate.get(row.report_date) ?? 0) + (row.booking_success_count ?? 0),
      );
    }

    return Array.from(byDate.entries()).map(([date, bookingSuccess]) => ({
      date,
      bookingSuccess,
    }));
  }

  /**
   * 最早的 report_date（整表）。用于仪表盘判断"运营投影是否已覆盖某查询范围"：
   * 仅当 earliest <= 范围起点时才用 daily_ops_report，避免前向累积导致少算。
   */
  async getEarliestReportDate(): Promise<string | null> {
    // selectOne：受熔断器保护（内部已 limit(1)）。
    const row = await this.selectOne<{ report_date: string }>('report_date', (q) =>
      q.order('report_date', { ascending: true }),
    );
    return row?.report_date ?? null;
  }
}

import { Injectable } from '@nestjs/common';
import { BaseRepository, QueryModifier } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';

/** 转化分析 RPC 的公共切窗/过滤参数（日期为 YYYY-MM-DD，按 report_date 闭区间）。 */
export interface ConversionStatsParams {
  startDate: string;
  endDate: string;
  corpId?: string;
  /** 所选小组；空数组/未传 = 不过滤。 */
  groups?: string[];
  /** 解析到所选小组的 bot 归一化 key（事件 group_name 缺失/未分组时按此归属）。 */
  groupBotIds?: string[];
}

export interface ConversionCohortStatsParams extends ConversionStatsParams {
  /** 下游事件观察截止日（含），≥ endDate；成熟期口径下 = 入列窗口末 + maturityDays。 */
  observeEndDate: string;
}

/** conversion_period_stats 返回行：scope=total（bucket 为空）/ day（bucket=日期）/ bot（bucket=bot_im_id）。 */
export interface ConversionPeriodStatsRow {
  scope: 'total' | 'day' | 'bot';
  bucket: string | null;
  bot_im_id: string | null;
  manager_name: string | null;
  group_name: string | null;
  friend_added: number;
  break_ice: number;
  booking: number;
  group_invite: number;
  interview_pass: number;
}

/** conversion_cohort_stats 返回行：每行 = 同一入列日 × 同一 bot 的成员汇总（各级已做单调约束）。 */
export interface ConversionCohortStatsRow {
  cohort_date: string;
  bot_im_id: string | null;
  manager_name: string | null;
  group_name: string | null;
  first_occurred_at: string;
  friend_added: number;
  break_ice: number;
  booking: number;
  group_invite: number;
  interview_pass: number;
}

export interface ConversionHandoffReasonRow {
  reason_code: string;
  event_count: number;
}

@Injectable()
export class OpsEventsAnalyticsRepository extends BaseRepository {
  protected readonly tableName = 'ops_events';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 同一时段口径聚合（RPC conversion_period_stats）：一次往返返回 总量/逐日/逐 bot 去重计数。
   * RPC 缺失、超时或熔断时返回 []（由 BaseRepository 记日志），调用方按空统计降级，
   * 禁止回退到翻页拉明细。
   */
  findPeriodStats(params: ConversionStatsParams): Promise<ConversionPeriodStatsRow[]> {
    return this.rpcAllPaged<ConversionPeriodStatsRow>('conversion_period_stats', {
      p_start_date: params.startDate,
      p_end_date: params.endDate,
      ...this.toFilterArgs(params),
    });
  }

  /** 同批追踪口径聚合（RPC conversion_cohort_stats）：每行 = 入列日 × bot 的成员各级计数。 */
  findCohortStats(params: ConversionCohortStatsParams): Promise<ConversionCohortStatsRow[]> {
    return this.rpcAllPaged<ConversionCohortStatsRow>('conversion_cohort_stats', {
      p_base_start: params.startDate,
      p_base_end: params.endDate,
      p_observe_end: params.observeEndDate,
      ...this.toFilterArgs(params),
    });
  }

  /** 转人工原因分布（RPC conversion_handoff_reasons），按 reason_code 计数降序。 */
  findHandoffReasons(params: ConversionStatsParams): Promise<ConversionHandoffReasonRow[]> {
    return this.rpcAllPaged<ConversionHandoffReasonRow>('conversion_handoff_reasons', {
      p_start_date: params.startDate,
      p_end_date: params.endDate,
      ...this.toFilterArgs(params),
    });
  }

  /**
   * 明细拉取（翻页拉全）：仅供小体量侧支使用——booking cohort 漏斗与取消/改约计数。
   * 主漏斗/趋势/账号对比一律走上面的 RPC 聚合，不要再用它拉主事件明细。
   */
  findOpsEvents<T>(columns: string, modifier: QueryModifier): Promise<T[]> {
    return this.fetchPagedRows<T>(this.tableName, columns, modifier);
  }

  findDailyOpsReportRows<T>(columns: string, modifier: QueryModifier): Promise<T[]> {
    return this.fetchPagedRows<T>('daily_ops_report', columns, modifier);
  }

  private toFilterArgs(params: ConversionStatsParams): Record<string, unknown> {
    const groups = params.groups?.filter(Boolean) ?? [];
    return {
      p_corp_id: params.corpId ?? null,
      p_groups: groups.length > 0 ? groups : null,
      p_group_bot_ids: groups.length > 0 ? (params.groupBotIds ?? []) : null,
    };
  }

  /**
   * 翻页拉全。走 BaseRepository.selectAllPaged：受进程级熔断器保护（DB 濒死时快速失败、
   * 记录故障，不绕过 事故后加固的熔断逻辑）。
   *
   * 两张表均以 id(bigserial) 为主键，调用方排序字段（report_date/occurred_at 等）非唯一，
   * 这里统一补 id 作稳定二级排序，避免 range 分页跨 1000 行时漏/重。
   */
  private fetchPagedRows<T>(
    tableName: string,
    columns: string,
    modifier: QueryModifier,
  ): Promise<T[]> {
    return this.selectAllPaged<T>(tableName, columns, (q) =>
      modifier(q).order('id', { ascending: true }),
    );
  }
}

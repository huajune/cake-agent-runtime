import { Injectable } from '@nestjs/common';
import { BaseRepository, QueryModifier } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';

@Injectable()
export class OpsEventsAnalyticsRepository extends BaseRepository {
  protected readonly tableName = 'ops_events';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  findOpsEvents<T>(columns: string, modifier: QueryModifier): Promise<T[]> {
    return this.fetchPagedRows<T>(this.tableName, columns, modifier);
  }

  findDailyOpsReportRows<T>(columns: string, modifier: QueryModifier): Promise<T[]> {
    return this.fetchPagedRows<T>('daily_ops_report', columns, modifier);
  }

  /**
   * 翻页拉全。走 BaseRepository.selectAllPaged：受进程级熔断器保护（DB 濒死时快速失败、
   * 记录故障，不绕过 2026-06-04 事故后加固的熔断逻辑）。
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

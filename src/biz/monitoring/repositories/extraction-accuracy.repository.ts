import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { ExtractionAccuracyFieldRow } from '../types/analytics.types';

// RPC（snake_case string）→ camelCase number 字段映射
const FIELD_MAPPING = {
  field: { field: 'field', type: 'string' as const },
  bookings: { field: 'bookings', type: 'int' as const },
  extracted: { field: 'extracted', type: 'int' as const },
  coveragePct: { field: 'coverage_pct', type: 'float' as const },
  accuracyPct: { field: 'accuracy_pct', type: 'float' as const },
  mismatches: { field: 'mismatches', type: 'int' as const },
  highConf: { field: 'high_conf', type: 'int' as const },
  highConfAccuracyPct: { field: 'high_conf_accuracy_pct', type: 'float' as const },
};

/**
 * 提取质量对账 Repository。
 *
 * 通过 extraction_accuracy_report RPC 比对 ops_events booking 真值与
 * message_processing_records 记忆快照提取值，逐字段算覆盖率/准确率。只读。
 */
@Injectable()
export class ExtractionAccuracyRepository extends BaseRepository {
  protected readonly tableName = 'ops_events';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 获取时间窗内逐字段提取质量对账。
   *
   * @param start 时间窗起点（含）
   * @param end 时间窗终点（不含）
   * @returns 每字段一行；RPC 不可用/无数据时返回空数组
   */
  async getReport(start: Date, end: Date): Promise<ExtractionAccuracyFieldRow[]> {
    const rows = await this.rpc<Array<Record<string, unknown>>>('extraction_accuracy_report', {
      p_start: start.toISOString(),
      p_end: end.toISOString(),
    });

    if (!rows) {
      return [];
    }

    return rows.map((row) => this.mapRpcRow<ExtractionAccuracyFieldRow>(row, FIELD_MAPPING));
  }
}

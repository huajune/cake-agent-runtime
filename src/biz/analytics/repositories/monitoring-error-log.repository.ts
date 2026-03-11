import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@core/supabase';
import { SupabaseService } from '@core/supabase';
import { ErrorLogDbRecord } from '../entities';
import { ErrorLogAlertType, ErrorLogRecord } from '../types';

/**
 * 监控错误日志 Repository
 *
 * 负责管理 monitoring_error_logs 表：
 * - 保存错误日志
 * - 按时间范围查询
 * - 清理过期日志
 */
@Injectable()
export class MonitoringErrorLogRepository extends BaseRepository {
  protected readonly tableName = 'monitoring_error_logs';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 保存错误日志
   */
  async saveErrorLog(log: ErrorLogRecord): Promise<void> {
    await this.upsert<ErrorLogDbRecord>(this.toDbRecord(log), {
      returnData: false,
    });
  }

  /**
   * 批量保存错误日志
   */
  async saveErrorLogsBatch(logs: ErrorLogRecord[]): Promise<void> {
    if (!logs || logs.length === 0) return;

    const records = logs.map((l) => this.toDbRecord(l));
    await this.upsertBatch(records);
    this.logger.log(`批量保存 ${logs.length} 条错误日志成功`);
  }

  /**
   * 查询最近的错误日志
   */
  async getRecentErrors(limit: number = 20): Promise<ErrorLogRecord[]> {
    const results = await this.select<ErrorLogDbRecord>('*', (q) =>
      q.order('timestamp', { ascending: false }).limit(limit),
    );

    return results.map((r) => this.fromDbRecord(r));
  }

  /**
   * 按时间戳范围查询错误日志
   */
  async getErrorLogsSince(cutoffTimestamp: number): Promise<ErrorLogRecord[]> {
    const results = await this.select<ErrorLogDbRecord>('*', (q) =>
      q.gte('timestamp', cutoffTimestamp).order('timestamp', { ascending: false }),
    );

    return results.map((r) => this.fromDbRecord(r));
  }

  /**
   * 清理过期错误日志
   * @returns 删除的记录数（通过 delete + select 获取）
   */
  async cleanupErrorLogs(retentionDays: number = 30): Promise<number> {
    const cutoffTimestamp = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    const deleted = await this.delete<ErrorLogDbRecord>(
      (q) => q.lt('timestamp', cutoffTimestamp),
      true,
    );

    const deletedCount = deleted.length;
    if (deletedCount > 0) {
      this.logger.log(`错误日志清理完成: 删除 ${deletedCount} 条 ${retentionDays} 天前的记录`);
    }
    return deletedCount;
  }

  /**
   * 清空错误日志
   */
  async clearAllRecords(): Promise<void> {
    if (!this.isAvailable()) return;
    await this.delete((q) => q.gte('timestamp', 0));
    this.logger.warn('[错误日志] 已清空所有数据库记录');
  }

  // ==================== 私有方法 ====================

  private toDbRecord(log: ErrorLogRecord): ErrorLogDbRecord {
    return {
      message_id: log.messageId,
      timestamp: log.timestamp,
      error: log.error,
      alert_type: log.alertType,
    };
  }

  private fromDbRecord(row: ErrorLogDbRecord): ErrorLogRecord {
    return {
      messageId: row.message_id,
      timestamp: Number(row.timestamp),
      error: row.error,
      alertType: row.alert_type as ErrorLogAlertType | undefined,
    };
  }
}

import { Injectable } from '@nestjs/common';
import type { DailyOpsReportRow } from '../entities/daily-ops-report.entity';
import { DailyOpsReportRepository } from '../repositories/daily-ops-report.repository';
import type { DailyOpsReportSums } from '../types/ops-events.types';

/**
 * daily_ops_report 业务读取入口。
 *
 * 外部模块只依赖本 service；Repository 保持为 ops-events 模块内部 DB 访问实现。
 */
@Injectable()
export class DailyOpsReportService {
  constructor(private readonly repository: DailyOpsReportRepository) {}

  findByReportDate(reportDate: string): Promise<DailyOpsReportRow[]> {
    return this.repository.findByReportDate(reportDate);
  }

  sumByDateRange(startReportDate: string, endReportDate: string): Promise<DailyOpsReportSums> {
    return this.repository.sumByDateRange(startReportDate, endReportDate);
  }

  sumBookingSuccessByDateRange(
    startReportDate: string,
    endReportDate: string,
  ): Promise<Array<{ date: string; bookingSuccess: number }>> {
    return this.repository.sumBookingSuccessByDateRange(startReportDate, endReportDate);
  }

  getEarliestReportDate(): Promise<string | null> {
    return this.repository.getEarliestReportDate();
  }
}

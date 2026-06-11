import { Injectable, Logger } from '@nestjs/common';
import { ExtractionAccuracyRepository } from '../../repositories/extraction-accuracy.repository';
import { ExtractionAccuracyFieldRow } from '../../types/analytics.types';

const DEFAULT_WINDOW_DAYS = 14;
const MAX_WINDOW_DAYS = 90;

/** 提取质量对账响应：时间窗 + 逐字段行 */
export interface ExtractionAccuracyReport {
  /** 统计天数（已归一化） */
  days: number;
  /** 时间窗起点 ISO */
  start: string;
  /** 时间窗终点 ISO */
  end: string;
  /** 逐字段对账行 */
  fields: ExtractionAccuracyFieldRow[];
}

/**
 * 提取质量对账服务。
 *
 * 编排 extraction_accuracy_report RPC，按天数切出时间窗，返回逐字段覆盖率/准确率，
 * 作为提取系统迭代的监控依据。
 */
@Injectable()
export class ExtractionAccuracyService {
  private readonly logger = new Logger(ExtractionAccuracyService.name);

  constructor(private readonly repository: ExtractionAccuracyRepository) {}

  /**
   * 获取最近 N 天的提取质量对账。
   *
   * @param days 统计天数（默认 14，范围 1-90）
   */
  async getReport(days?: number): Promise<ExtractionAccuracyReport> {
    const normalizedDays = this.normalizeDays(days);
    const end = new Date();
    const start = new Date(end.getTime() - normalizedDays * 24 * 60 * 60 * 1000);

    this.logger.debug(`获取提取质量对账: 最近 ${normalizedDays} 天`);

    const fields = await this.repository.getReport(start, end);

    return {
      days: normalizedDays,
      start: start.toISOString(),
      end: end.toISOString(),
      fields,
    };
  }

  private normalizeDays(days?: number): number {
    if (!Number.isFinite(days) || days === undefined || days < 1) {
      return DEFAULT_WINDOW_DAYS;
    }

    return Math.min(Math.floor(days), MAX_WINDOW_DAYS);
  }
}

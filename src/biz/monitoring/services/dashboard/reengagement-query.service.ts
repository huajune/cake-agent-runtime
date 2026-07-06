import { Injectable, Logger } from '@nestjs/common';
import { addLocalDays, parseLocalDateStart } from '@infra/utils/date.util';
import {
  ReengagementTouchFilters,
  ReengagementTouchStatus,
} from '../../entities/reengagement-touch.entity';
import { ReengagementTouchRepository } from '../../repositories/reengagement-touch.repository';

/**
 * 二次触发追溯页查询编排：日期补全 + 参数解析，供 AnalyticsController 使用。
 */
@Injectable()
export class ReengagementQueryService {
  private readonly logger = new Logger(ReengagementQueryService.name);

  constructor(private readonly repository: ReengagementTouchRepository) {}

  /** 分页列表（startDate/endDate 为 YYYY-MM-DD，自动补全为当日 00:00 ~ 23:59） */
  async getRecords(query: {
    startDate?: string;
    endDate?: string;
    status?: string;
    scenarioCode?: string;
    sessionId?: string;
    limit?: string;
    offset?: string;
  }) {
    const filters: ReengagementTouchFilters = {};
    if (query.startDate) filters.startDate = this.dayStart(query.startDate);
    if (query.endDate) filters.endDate = this.dayEnd(query.endDate);
    if (query.status) filters.status = query.status as ReengagementTouchStatus;
    if (query.scenarioCode) filters.scenarioCode = query.scenarioCode;
    if (query.sessionId) filters.sessionId = query.sessionId;
    if (query.limit) filters.limit = parseInt(query.limit, 10);
    if (query.offset) filters.offset = parseInt(query.offset, 10);

    this.logger.debug(`获取二次触发追溯记录: ${JSON.stringify(filters)}`);
    return this.repository.getRecords(filters);
  }

  /** 详情（含 generated_text + events 全轨迹） */
  async getRecordByTouchKey(touchKey: string) {
    return this.repository.getRecordByTouchKey(touchKey);
  }

  /** 时间范围内按 status + scenario 分组计数 */
  async getStats(startDate: string, endDate: string) {
    return this.repository.getStats(this.dayStart(startDate), this.dayEnd(endDate));
  }

  // 日界必须用 Asia/Shanghai 口径（date.util 统一封装）——生产容器时区是 UTC，
  // 直接 setHours 会把"今天"算成上海 08:00 起，凌晨的记录整段查不到。
  private dayStart(date: string): string {
    return parseLocalDateStart(date).toISOString();
  }

  private dayEnd(date: string): string {
    return new Date(addLocalDays(parseLocalDateStart(date), 1).getTime() - 1).toISOString();
  }
}

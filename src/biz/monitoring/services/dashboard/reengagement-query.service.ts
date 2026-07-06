import { Injectable, Logger } from '@nestjs/common';
import { addLocalDays, parseLocalDateStart } from '@infra/utils/date.util';
import {
  ReengagementCandidateOverviewRow,
  ReengagementCandidateSummary,
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

  /**
   * 候选人视角：一行一个候选人（session），带各场景当前态与"下一次待发任务"。
   * RPC 返回每 (session, scenario) 最新触达的行集，这里按 session 分组组装。
   */
  async getCandidateOverview(query: {
    startDate?: string;
    endDate?: string;
    scenarioCode?: string;
    sessionId?: string;
    pendingOnly?: string;
    limit?: string;
    offset?: string;
  }): Promise<{ total: number; candidates: ReengagementCandidateSummary[] }> {
    const rows = await this.repository.getCandidateOverview({
      startDate: query.startDate ? this.dayStart(query.startDate) : undefined,
      endDate: query.endDate ? this.dayEnd(query.endDate) : undefined,
      scenarioCode: query.scenarioCode,
      sessionId: query.sessionId,
      pendingOnly: query.pendingOnly === 'true',
      limit: query.limit ? parseInt(query.limit, 10) : undefined,
      offset: query.offset ? parseInt(query.offset, 10) : undefined,
    });
    return this.groupCandidates(rows);
  }

  private groupCandidates(rows: ReengagementCandidateOverviewRow[]): {
    total: number;
    candidates: ReengagementCandidateSummary[];
  } {
    const bySession = new Map<string, ReengagementCandidateSummary>();
    const now = Date.now();
    for (const row of rows) {
      let candidate = bySession.get(row.session_id);
      if (!candidate) {
        candidate = {
          sessionId: row.session_id,
          userId: row.user_id,
          corpId: row.corp_id,
          candidateName: row.candidate_name,
          managerName: row.manager_name,
          botImId: row.bot_im_id,
          latestAt: row.session_latest_at,
          nextTouch: null,
          scenarios: [],
        };
        bySession.set(row.session_id, candidate);
      }
      candidate.scenarios.push({
        scenarioCode: row.scenario_code,
        touchKey: row.touch_key,
        status: row.status,
        decisionReason: row.decision_reason,
        shadow: row.shadow,
        fireAt: row.fire_at,
        sentAt: row.sent_at,
        outcomeKind: row.outcome_kind,
        updatedAt: row.updated_at,
      });
      // 下一次待发 = 各场景中 scheduled/rescheduled 且 fire_at 未到者取最早
      const pending =
        (row.status === 'scheduled' || row.status === 'rescheduled') &&
        row.fire_at != null &&
        Date.parse(row.fire_at) > now;
      if (
        pending &&
        (!candidate.nextTouch || Date.parse(row.fire_at!) < Date.parse(candidate.nextTouch.fireAt))
      ) {
        candidate.nextTouch = {
          scenarioCode: row.scenario_code,
          touchKey: row.touch_key,
          fireAt: row.fire_at!,
        };
      }
    }
    // 行序即 RPC 的候选人排序（latest_at 倒序），Map 保序
    return { total: rows[0]?.total_sessions ?? 0, candidates: Array.from(bySession.values()) };
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

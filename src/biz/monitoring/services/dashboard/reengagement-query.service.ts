import { Injectable, Logger } from '@nestjs/common';
import { addLocalDays, parseLocalDateStart } from '@infra/utils/date.util';
import { toErrorMessage } from '@infra/utils/error.util';
import {
  REENGAGEMENT_STATS_EXCLUDED_DECISION_REASONS,
  ReengagementCandidateOverviewRow,
  ReengagementCandidateSummary,
  ReengagementTouchFilters,
  ReengagementTouchStatsRow,
  ReengagementTouchStatus,
  ReengagementWeeklyFunnelBucket,
} from '../../entities/reengagement-touch.entity';
import { ReengagementTouchRepository } from '../../repositories/reengagement-touch.repository';

/** 周度漏斗最长查询跨度：13 周（约一季度），防止 Dashboard 传超长范围扫全表。 */
const WEEKLY_FUNNEL_MAX_DAYS = 13 * 7;

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
    const status = this.parseStatus(query.status);
    if (status) filters.status = status;
    if (query.scenarioCode) filters.scenarioCode = query.scenarioCode;
    if (query.sessionId) filters.sessionId = query.sessionId;
    const limit = this.parsePositiveInt(query.limit);
    if (limit !== undefined) filters.limit = limit;
    const offset = this.parsePositiveInt(query.offset);
    if (offset !== undefined) filters.offset = offset;

    this.logger.debug(`获取二次触发追溯记录: ${JSON.stringify(filters)}`);
    return this.repository.getRecords(filters);
  }

  /** 详情（含 generated_text + events 全轨迹） */
  async getRecordByTouchKey(touchKey: string) {
    return this.repository.getRecordByTouchKey(touchKey);
  }

  /**
   * 时间范围内按 status + scenario 分组计数。
   *
   * 口径：剔除 REENGAGEMENT_STATS_EXCLUDED_DECISION_REASONS 命中的「不适用」记录
   * （如面试提醒提前 2 天档因报名到面试不足 3 天而跳过），它们不是一次触达，不进「总触达」。
   * 剔除查询失败时退回未剔除的原始分组并告警，不让统计卡整体报错。
   */
  async getStats(startDate: string, endDate: string): Promise<ReengagementTouchStatsRow[]> {
    const start = this.dayStart(startDate);
    const end = this.dayEnd(endDate);
    const rows = await this.repository.getStats(start, end);
    let excluded: ReengagementTouchStatsRow[] = [];
    try {
      excluded = await this.repository.getStatsByDecisionReasons(
        start,
        end,
        REENGAGEMENT_STATS_EXCLUDED_DECISION_REASONS,
      );
    } catch (error) {
      this.logger.warn(`复聊统计剔除不适用记录失败，退回原始分组: ${toErrorMessage(error)}`);
      return rows;
    }
    return subtractStatsRows(rows, excluded);
  }

  /**
   * 周度漏斗：登记 → 发出 → 6h 内候选人回复（按创建周 cohort，Asia/Shanghai）。
   * RPC 按周 × 场景返回，这里合并到周并算回复率；跨度超过 13 周时只保留最近 13 周。
   */
  async getWeeklyFunnel(
    startDate: string,
    endDate: string,
  ): Promise<ReengagementWeeklyFunnelBucket[]> {
    const end = parseLocalDateStart(endDate);
    const requestedStart = parseLocalDateStart(startDate);
    const earliestStart = addLocalDays(end, -(WEEKLY_FUNNEL_MAX_DAYS - 1));
    const start =
      requestedStart.getTime() < earliestStart.getTime() ? earliestStart : requestedStart;
    const rows = await this.repository.getWeeklyFunnel(
      start.toISOString(),
      addLocalDays(end, 1).toISOString(),
    );
    const byWeek = new Map<string, ReengagementWeeklyFunnelBucket>();
    for (const row of rows) {
      const bucket = byWeek.get(row.week_start) ?? {
        weekStart: row.week_start,
        registered: 0,
        sent: 0,
        replied6h: 0,
        replyRate: null,
      };
      bucket.registered += Number(row.registered) || 0;
      bucket.sent += Number(row.sent) || 0;
      bucket.replied6h += Number(row.replied_6h) || 0;
      byWeek.set(row.week_start, bucket);
    }
    return [...byWeek.values()]
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
      .map((bucket) => ({
        ...bucket,
        replyRate: bucket.sent > 0 ? bucket.replied6h / bucket.sent : null,
      }));
  }

  /**
   * 候选人视角：一行一个候选人（session），带各场景当前态与"下一次待发任务"。
   * RPC 返回每 (session, scenario) 最新触达的行集，这里按 session 分组组装。
   */
  async getCandidateOverview(query: {
    startDate?: string;
    endDate?: string;
    status?: string;
    scenarioCode?: string;
    keyword?: string;
    pendingOnly?: string;
    limit?: string;
    offset?: string;
  }): Promise<{ total: number; candidates: ReengagementCandidateSummary[] }> {
    const rows = await this.repository.getCandidateOverview({
      startDate: query.startDate ? this.dayStart(query.startDate) : undefined,
      endDate: query.endDate ? this.dayEnd(query.endDate) : undefined,
      status: this.parseStatus(query.status),
      scenarioCode: query.scenarioCode,
      keyword: query.keyword?.trim() || undefined,
      pendingOnly: query.pendingOnly === 'true',
      limit: this.parsePositiveInt(query.limit),
      offset: this.parsePositiveInt(query.offset),
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
      if (row.status === ReengagementTouchStatus.Superseded) {
        continue;
      }
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
      // 下一次待发 = 各场景中 scheduled 且 fire_at 未到者取最早
      const pending =
        row.status === 'scheduled' && row.fire_at != null && Date.parse(row.fire_at) > now;
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

  /**
   * 分页参数安全解析：非数字（NaN）或 <=0 时返回 undefined，由 Repository 兜底默认值。
   * Controller 层无 ParseIntPipe，parseInt('abc') 的 NaN 会穿透 `??` 直达
   * .range(NaN, ...) / p_limit，被 PostgREST 拒绝为 500。
   */
  /** status 白名单校验：非枚举值按未过滤处理，不把任意字符串透传进 PostgREST .eq()。 */
  private parseStatus(value: string | undefined): ReengagementTouchStatus | undefined {
    if (!value) return undefined;
    return (Object.values(ReengagementTouchStatus) as string[]).includes(value)
      ? (value as ReengagementTouchStatus)
      : undefined;
  }

  private parsePositiveInt(value: string | undefined): number | undefined {
    if (value === undefined || value === '') return undefined;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
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

/** 按 (status, scenario_code) 从 rows 里扣减 excluded 的计数；扣成 0 或负数的桶整行去掉。 */
function subtractStatsRows(
  rows: ReengagementTouchStatsRow[],
  excluded: ReengagementTouchStatsRow[],
): ReengagementTouchStatsRow[] {
  if (excluded.length === 0) return rows;
  const excludedByKey = new Map<string, number>();
  for (const row of excluded) {
    const key = `${row.status}|${row.scenario_code}`;
    excludedByKey.set(key, (excludedByKey.get(key) ?? 0) + Number(row.cnt));
  }
  const result: ReengagementTouchStatsRow[] = [];
  for (const row of rows) {
    const key = `${row.status}|${row.scenario_code}`;
    const cnt = Number(row.cnt) - (excludedByKey.get(key) ?? 0);
    if (cnt > 0) result.push({ ...row, cnt });
  }
  return result;
}

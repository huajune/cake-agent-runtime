import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsMetricsService } from '@analytics/metrics/analytics-metrics.service';
import { AnalyticsTrendBuilderService } from '@analytics/trends/analytics-trend-builder.service';
import { addLocalDays, getLocalDayStart, parseLocalDateStart } from '@infra/utils/date.util';
import { MessageProcessingRecord, MonitoringErrorLog } from '@shared-types/tracking.types';
import {
  HourlyStats,
  MetricsData,
  ResponseMinuteTrendPoint,
  AlertTrendPoint,
  AlertTypeMetric,
  TodayUser,
  BusinessMetricTrendPoint,
  TimeRange,
  ALL_RANGE_START_DATE,
} from '../../types/analytics.types';
import { MonitoringCacheService } from '../tracking/monitoring-cache.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { MonitoringRecordRepository } from '../../repositories/record.repository';
import { MonitoringHourlyStatsRepository } from '../../repositories/hourly-stats.repository';
import { MonitoringErrorLogRepository } from '../../repositories/error-log.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import type { UserActivityAggregate } from '@biz/user/types/user.types';
import { MessageTrackingService } from '../tracking/message-tracking.service';
import { MessageProcessor } from '@wecom/message/runtime/message.processor';
import * as os from 'os';
import {
  calculateDashboardTimeRanges,
  getDashboardTimeRangeCutoff,
  toMessageProcessingRecords,
} from './analytics-dashboard.util';
import { getTrendHours } from './analytics-calc.util';

const DEFAULT_USER_TREND_DAYS = 30;
const MAX_USER_TREND_DAYS = 730;

function normalizeUserTrendDays(days?: number): number {
  if (!Number.isFinite(days) || days === undefined) {
    return DEFAULT_USER_TREND_DAYS;
  }
  // days=0 表示「全部」：user_activity 永久保留，从业务数据起点算到今天
  if (days === 0) {
    const start = new Date(`${ALL_RANGE_START_DATE}T00:00:00+08:00`);
    const elapsed = Math.floor((Date.now() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    return Math.max(1, Math.min(elapsed, MAX_USER_TREND_DAYS));
  }
  if (days < 1) {
    return DEFAULT_USER_TREND_DAYS;
  }

  return Math.min(Math.floor(days), MAX_USER_TREND_DAYS);
}

const DETAIL_RECORD_LIMIT_BY_RANGE: Record<TimeRange, number> = {
  all: 2000,
  today: 2000,
  week: 5000,
  month: 10000,
  twoMonths: 20000,
  threeMonths: 30000,
};

/**
 * 单项数据查询服务
 * 负责系统监控、趋势数据、指标、消息统计、用户等独立查询接口
 */
@Injectable()
export class AnalyticsQueryService {
  private readonly logger = new Logger(AnalyticsQueryService.name);

  private todayUsersCache: { value: UserActivityAggregate[]; expireAt: number } | null = null;

  constructor(
    private readonly messageProcessingService: MessageProcessingService,
    private readonly monitoringRecordRepository: MonitoringRecordRepository,
    private readonly hourlyStatsRepository: MonitoringHourlyStatsRepository,
    private readonly errorLogRepository: MonitoringErrorLogRepository,
    private readonly userHostingService: UserHostingService,
    private readonly cacheService: MonitoringCacheService,
    private readonly messageTrackingService: MessageTrackingService,
    private readonly messageProcessor: MessageProcessor,
    private readonly analyticsMetricsService: AnalyticsMetricsService,
    private readonly analyticsTrendBuilder: AnalyticsTrendBuilderService,
  ) {}

  // ========================================
  // 系统监控 / 趋势 / 指标 / 消息统计
  // ========================================

  /**
   * 获取 System 监控数据（轻量级）
   */
  async getSystemMonitoringAsync(): Promise<{
    queue: {
      activeRequests: number;
      peakActiveRequests: number;
      queueWaitingJobs: number;
      avgQueueDuration: number;
    };
    alertsSummary: {
      total: number;
      lastHour: number;
      last24Hours: number;
      byType: AlertTypeMetric[];
    };
    alertTrend: AlertTrendPoint[];
  }> {
    try {
      const now = Date.now();
      const [queueDurationStats, errorLogs, activeRequests, peakActiveRequests, queueStatus] =
        await Promise.all([
          // 只要一个均值，交给 DB 聚合；拉明细会因 jsonb 列 detoast 拖到数秒
          this.messageProcessingService.getQueueDurationStats(now - 24 * 60 * 60 * 1000, now),
          this.getErrorLogsByTimeRange('today'),
          this.messageTrackingService.getActiveRequests(),
          this.messageTrackingService.getPeakActiveRequests(),
          this.messageProcessor.getQueueStatus(),
        ]);

      const queue = {
        activeRequests,
        peakActiveRequests,
        queueWaitingJobs: queueStatus.waiting,
        avgQueueDuration: Math.round(queueDurationStats.avgQueueDuration),
      };
      const alertsSummary = this.analyticsMetricsService.calculateAlertsSummary(errorLogs);
      const alertTrend = this.analyticsTrendBuilder.buildAlertTrend(errorLogs, 'today');

      return { queue, alertsSummary, alertTrend };
    } catch (error) {
      this.logger.error('获取System监控数据失败:', error);
      throw error;
    }
  }

  /**
   * 获取趋势数据（独立接口）
   */
  async getTrendsDataAsync(timeRange: TimeRange = 'today'): Promise<{
    dailyTrend: { hourly: HourlyStats[] };
    responseTrend: ResponseMinuteTrendPoint[];
    alertTrend: AlertTrendPoint[];
    businessTrend: BusinessMetricTrendPoint[];
  }> {
    try {
      const timeRanges = calculateDashboardTimeRanges(timeRange);
      const { currentStart, currentEnd } = timeRanges;

      const [currentRecords, errorLogs, trends] = await Promise.all([
        this.getRecordsByTimeRange(currentStart, currentEnd),
        this.getErrorLogsByTimeRange(timeRange),
        this.calculateTrends(timeRange),
      ]);

      return {
        dailyTrend: trends,
        responseTrend: this.analyticsTrendBuilder.buildResponseTrend(currentRecords, timeRange),
        alertTrend: this.analyticsTrendBuilder.buildAlertTrend(errorLogs, timeRange),
        businessTrend: this.analyticsTrendBuilder.buildBusinessTrend(currentRecords, timeRange),
      };
    } catch (error) {
      this.logger.error('获取趋势数据失败:', error);
      throw error;
    }
  }

  /**
   * 获取详细指标数据
   */
  async getMetricsDataAsync(): Promise<MetricsData> {
    try {
      // hourlyStats 曾随 metrics 每 5 秒拉 72 行，唯一消费方（系统监控页）只读 percentiles.p95，已移除
      const [detailRecords, globalCounters, recentErrors] = await Promise.all([
        this.getRecentDetailRecords(50),
        this.cacheService.getCounters(),
        this.getRecentErrors(20),
      ]);

      const MAX_DURATION_MS = 60 * 1000;
      const durations = detailRecords
        .filter(
          (r) =>
            r.status === 'success' &&
            r.totalDuration !== undefined &&
            r.totalDuration <= MAX_DURATION_MS,
        )
        .map((r) => r.totalDuration!);

      const percentiles = this.analyticsMetricsService.calculatePercentilesFromArray(durations);

      const slowestRecords = [...detailRecords]
        .filter((r) => r.totalDuration !== undefined)
        .sort((a, b) => (b.totalDuration || 0) - (a.totalDuration || 0))
        .slice(0, 10);

      return {
        detailRecords,
        globalCounters,
        percentiles,
        slowestRecords,
        recentAlertCount: recentErrors.length,
      };
    } catch (error) {
      this.logger.error('获取指标数据失败:', error);
      return {
        detailRecords: [],
        globalCounters: {
          totalMessages: 0,
          totalSuccess: 0,
          totalFailure: 0,
          totalAiDuration: 0,
          totalSendDuration: 0,
          totalFallback: 0,
          totalFallbackSuccess: 0,
          totalOutputLeakSkipped: 0,
          totalHostingPausedSkipped: 0,
        },
        percentiles: { p50: 0, p95: 0, p99: 0, p999: 0 },
        slowestRecords: [],
        recentAlertCount: 0,
      };
    }
  }

  /**
   * 获取消息统计数据（聚合查询）
   */
  async getMessageStatsAsync(
    startTime: number,
    endTime: number,
  ): Promise<{ total: number; success: number; failed: number; avgDuration: number }> {
    return this.messageProcessingService.getMessageStatsByTimestamps(startTime, endTime);
  }

  // ========================================
  // 用户相关
  // ========================================

  async getTodayUsers(): Promise<TodayUser[]> {
    const CACHE_TTL_MS = 30_000;
    const now = Date.now();
    let dbUsers: UserActivityAggregate[];

    if (this.todayUsersCache && this.todayUsersCache.expireAt > now) {
      this.logger.debug(`[Cache] 命中今日用户缓存 (${this.todayUsersCache.value.length} 条记录)`);
      dbUsers = this.todayUsersCache.value;
    } else {
      const todayStart = getLocalDayStart();
      dbUsers = await this.userHostingService.getActiveUsersByDateRange(todayStart, new Date());

      if (dbUsers.length > 0) {
        this.todayUsersCache = { value: dbUsers, expireAt: now + CACHE_TTL_MS };
      }
    }

    const pausedSet = await this.userHostingService.getPausedUserIdSet();
    return this.mapTodayUsers(dbUsers, pausedSet);
  }

  async getTodayUsersFromDatabase(): Promise<TodayUser[]> {
    const todayStart = getLocalDayStart();
    return this.buildTodayUsers(todayStart, new Date());
  }

  // ========================================
  // 系统管理接口
  // ========================================

  /**
   * 获取系统状态信息
   */
  async getSystemInfo() {
    return {
      status: 'healthy',
      uptime: process.uptime(),
      memory: {
        used: process.memoryUsage().heapUsed,
        total: os.totalmem(),
        rss: process.memoryUsage().rss,
        heapTotal: process.memoryUsage().heapTotal,
      },
      cpu: os.loadavg()[0],
      platform: os.platform(),
      nodeVersion: process.version,
    };
  }

  async getUsersByDate(date: string): Promise<TodayUser[]> {
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(date)) {
      this.logger.warn(`无效的日期格式 [${date}]，应为 YYYY-MM-DD`);
      return [];
    }

    const startDate = parseLocalDateStart(date);
    const endDate = new Date(addLocalDays(startDate, 1).getTime() - 1);

    return this.buildTodayUsers(startDate, endDate);
  }

  async getUsersByDays(days?: number): Promise<TodayUser[]> {
    const rangeDays = normalizeUserTrendDays(days);
    const endDate = new Date();
    const startDate = addLocalDays(getLocalDayStart(endDate), -(rangeDays - 1));

    return this.buildTodayUsers(startDate, endDate);
  }

  /**
   * 从 user_activity 聚合构建 TodayUser 列表，并叠加暂停托管状态。
   */
  private async buildTodayUsers(startDate: Date, endDate: Date): Promise<TodayUser[]> {
    const dbUsers = await this.userHostingService.getActiveUsersByDateRange(startDate, endDate);
    const pausedSet = await this.userHostingService.getPausedUserIdSet();

    return this.mapTodayUsers(dbUsers, pausedSet);
  }

  private mapTodayUsers(
    dbUsers: UserActivityAggregate[],
    pausedSet: ReadonlySet<string>,
  ): TodayUser[] {
    return dbUsers.map((user) => ({
      chatId: user.chatId,
      odId: user.odId || user.chatId,
      odName: user.odName || user.chatId,
      botUserId: user.botUserId,
      imBotId: user.imBotId,
      messageCount: user.messageCount,
      tokenUsage: user.tokenUsage,
      firstActiveAt: user.firstActiveAt,
      lastActiveAt: user.lastActiveAt,
      isPaused: pausedSet.has(user.chatId),
    }));
  }

  async getUserTrend(
    days?: number,
  ): Promise<Array<{ date: string; userCount: number; messageCount: number }>> {
    const trendDays = normalizeUserTrendDays(days);
    const endDate = new Date();
    const startDate = addLocalDays(getLocalDayStart(endDate), -(trendDays - 1));
    const stats = await this.userHostingService.getDailyActivityStats(startDate, endDate);
    return stats.map((s) => ({
      date: s.date,
      userCount: s.userCount,
      messageCount: s.messageCount,
    }));
  }

  async getChatTrend(
    days = 7,
  ): Promise<
    Array<{ hour: string; message_count: number; active_users: number; active_chats: number }>
  > {
    this.logger.debug(`获取聊天趋势: 最近 ${days} 天`);
    const endDate = new Date();
    const startDate = addLocalDays(getLocalDayStart(endDate), -days);
    const trend = await this.monitoringRecordRepository.getDashboardHourlyTrend(startDate, endDate);
    return trend.map((item) => ({
      hour: item.hour,
      message_count: item.messageCount,
      active_users: item.uniqueUsers,
      active_chats: 0,
    }));
  }

  public async getRecentDetailRecords(limit: number = 50): Promise<MessageProcessingRecord[]> {
    try {
      const result = await this.messageProcessingService.getRecordsByTimestamps({
        limit,
        // 不带 includeTotal:false 时会对整表做一次无 WHERE 的 count(*)（6.2 万行，实测 1.5s），
        // 而调用方只要这 50 行本身，从不读 total。
        includeTotal: false,
        // summary 投影去掉 memory_snapshot / tool_calls / agent_steps 等大 jsonb：
        // 宽投影下 50 行要传 1.56MB（单行 31KB），detoast 实测 3.0s。
        projection: 'summary',
      });
      return toMessageProcessingRecords(result.records);
    } catch (error) {
      this.logger.error('查询最近消息记录异常:', error);
      return [];
    }
  }

  // ========================================
  // 私有数据访问方法
  // ========================================

  private async getRecordsByTimeRange(
    startTime: number,
    endTime: number,
  ): Promise<MessageProcessingRecord[]> {
    try {
      const records = await this.messageProcessingService.getRecordsByTimeRange(startTime, endTime);
      return toMessageProcessingRecords(records);
    } catch (error) {
      this.logger.error('按时间范围查询消息记录失败:', error);
      return [];
    }
  }

  private async getDetailRecordsByTimeRange(range: TimeRange): Promise<MessageProcessingRecord[]> {
    try {
      const cutoffTime = this.getTimeRangeCutoff(range);
      const result = await this.messageProcessingService.getRecordsByTimestamps({
        startTime: cutoffTime.getTime(),
        limit: DETAIL_RECORD_LIMIT_BY_RANGE[range] ?? DETAIL_RECORD_LIMIT_BY_RANGE.today,
      });
      return toMessageProcessingRecords(result.records);
    } catch (error) {
      this.logger.error(`查询消息记录异常 [${range}]:`, error);
      return [];
    }
  }

  private async getHourlyStats(hours: number = 72): Promise<HourlyStats[]> {
    try {
      return (await this.hourlyStatsRepository.getRecentHourlyStats(
        hours,
      )) as unknown as HourlyStats[];
    } catch (error) {
      this.logger.error('查询小时统计失败:', error);
      return [];
    }
  }

  private async getRecentErrors(limit: number = 20): Promise<MonitoringErrorLog[]> {
    try {
      return (await this.errorLogRepository.getRecentErrors(limit)) as MonitoringErrorLog[];
    } catch (error) {
      this.logger.error('查询错误日志失败:', error);
      return [];
    }
  }

  private async getErrorLogsByTimeRange(range: TimeRange): Promise<MonitoringErrorLog[]> {
    try {
      const cutoff = this.getTimeRangeCutoff(range);
      return (await this.errorLogRepository.getErrorLogsSince(
        cutoff.getTime(),
      )) as MonitoringErrorLog[];
    } catch (error) {
      this.logger.error(`查询错误日志失败 [${range}]:`, error);
      return [];
    }
  }

  // ========================================
  // 私有计算方法
  // ========================================

  private getTimeRangeCutoff(range: TimeRange): Date {
    return getDashboardTimeRangeCutoff(range);
  }

  private async calculateTrends(timeRange: TimeRange) {
    const hours = getTrendHours(timeRange);
    const hourlyStats = await this.getHourlyStats(hours);
    return { hourly: hourlyStats };
  }
}

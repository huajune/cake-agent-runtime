import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsMetricsService } from '@analytics/metrics/analytics-metrics.service';
import { AnalyticsTrendBuilderService } from '@analytics/trends/analytics-trend-builder.service';
import {
  addLocalDays,
  formatLocalDate,
  formatLocalMinute,
  getLocalDayStart,
  parseLocalDateStart,
} from '@infra/utils/date.util';
import {
  MessageProcessingRecord,
  MonitoringErrorLog,
  MonitoringGlobalCounters,
  AlertErrorType,
} from '@shared-types/tracking.types';
import {
  HourlyStats,
  MetricsData,
  ResponseMinuteTrendPoint,
  AlertTrendPoint,
  AlertTypeMetric,
  TimeRange,
  TodayUser,
  BusinessMetricTrendPoint,
} from '../../types/analytics.types';
import { MonitoringCacheService } from '../tracking/monitoring-cache.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { MonitoringRecordRepository } from '../../repositories/record.repository';
import { MonitoringHourlyStatsRepository } from '../../repositories/hourly-stats.repository';
import { MonitoringErrorLogRepository } from '../../repositories/error-log.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { MessageTrackingService } from '../tracking/message-tracking.service';
import { MessageProcessor } from '@wecom/message/runtime/message.processor';
import * as os from 'os';
import {
  calculateDashboardTimeRanges,
  getDashboardTimeRangeCutoff,
  toMessageProcessingRecords,
} from './analytics-dashboard.util';

/**
 * 单项数据查询服务
 * 负责系统监控、趋势数据、指标、消息统计、用户等独立查询接口
 */
@Injectable()
export class AnalyticsQueryService {
  private readonly logger = new Logger(AnalyticsQueryService.name);

  private todayUsersCache: { value: TodayUser[]; expireAt: number } | null = null;

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
      const [currentRecords, errorLogs, activeRequests, peakActiveRequests, queueStatus] =
        await Promise.all([
          this.getRecordsByTimeRange(Date.now() - 24 * 60 * 60 * 1000, Date.now()),
          this.getErrorLogsByTimeRange('today'),
          this.messageTrackingService.getActiveRequests(),
          this.messageTrackingService.getPeakActiveRequests(),
          this.messageProcessor.getQueueStatus(),
        ]);

      const queue = this.analyticsMetricsService.calculateQueueMetrics(currentRecords, {
        activeRequests,
        peakActiveRequests,
        queueWaitingJobs: queueStatus.waiting,
      });
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
      const [detailRecords, hourlyStats, globalCounters, recentErrors] = await Promise.all([
        this.getRecentDetailRecords(50),
        this.getHourlyStats(72),
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
        hourlyStats,
        globalCounters,
        percentiles,
        slowestRecords,
        recentAlertCount: recentErrors.length,
      };
    } catch (error) {
      this.logger.error('获取指标数据失败:', error);
      return {
        detailRecords: [],
        hourlyStats: [],
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

    if (this.todayUsersCache && this.todayUsersCache.expireAt > now) {
      this.logger.debug(`[Cache] 命中今日用户缓存 (${this.todayUsersCache.value.length} 条记录)`);
      return this.todayUsersCache.value;
    }

    const users = await this.getTodayUsersFromDatabase();

    if (users.length > 0) {
      this.todayUsersCache = { value: users, expireAt: now + CACHE_TTL_MS };
    }

    return users;
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

  /**
   * 从 user_activity 聚合构建 TodayUser 列表，并叠加暂停托管状态。
   */
  private async buildTodayUsers(startDate: Date, endDate: Date): Promise<TodayUser[]> {
    const dbUsers = await this.userHostingService.getActiveUsersByDateRange(startDate, endDate);

    const pausedSet = new Set<string>();
    for (const user of dbUsers) {
      const status = await this.userHostingService.getUserHostingStatus(user.chatId);
      if (status.isPaused) {
        pausedSet.add(user.chatId);
      }
    }

    return dbUsers.map((user) => ({
      chatId: user.chatId,
      odId: user.odId || user.chatId,
      odName: user.odName || user.chatId,
      groupId: user.groupId,
      groupName: user.groupName,
      botUserId: user.botUserId,
      imBotId: user.imBotId,
      messageCount: user.messageCount,
      tokenUsage: user.tokenUsage,
      firstActiveAt: user.firstActiveAt,
      lastActiveAt: user.lastActiveAt,
      isPaused: pausedSet.has(user.chatId),
    }));
  }

  async getUserTrend(): Promise<Array<{ date: string; userCount: number; messageCount: number }>> {
    const endDate = new Date();
    const startDate = addLocalDays(getLocalDayStart(endDate), -30);
    const stats = await this.messageProcessingService.getDailyUserStats(startDate, endDate);
    return stats.map((s) => ({
      date: s.date,
      userCount: s.uniqueUsers,
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
      const result = await this.messageProcessingService.getRecordsByTimestamps({ limit });
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
      const limitByRange = { today: 2000, week: 5000, month: 10000 };
      const result = await this.messageProcessingService.getRecordsByTimestamps({
        startTime: cutoffTime.getTime(),
        limit: limitByRange[range] || 2000,
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

  private calculatePercentilesFromArray(values: number[]): {
    p50: number;
    p95: number;
    p99: number;
    p999: number;
  } {
    if (values.length === 0) return { p50: 0, p95: 0, p99: 0, p999: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const getPercentile = (p: number) => {
      const index = Math.ceil((p / 100) * sorted.length) - 1;
      return sorted[Math.max(0, index)] || 0;
    };
    return {
      p50: getPercentile(50),
      p95: getPercentile(95),
      p99: getPercentile(99),
      p999: getPercentile(99.9),
    };
  }

  private calculateQueueMetrics(
    records: MessageProcessingRecord[],
    _globalCounters: MonitoringGlobalCounters,
  ) {
    const queueDurations = records.filter((r) => r.queueDuration).map((r) => r.queueDuration!);
    const avgQueueDuration =
      queueDurations.length > 0
        ? queueDurations.reduce((a, b) => a + b, 0) / queueDurations.length
        : 0;

    return {
      activeRequests: 0,
      peakActiveRequests: 0,
      queueWaitingJobs: 0,
      avgQueueDuration: parseFloat(avgQueueDuration.toFixed(0)),
    };
  }

  private calculateAlertsSummary(errorLogs: MonitoringErrorLog[]) {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    return {
      total: errorLogs.length,
      lastHour: errorLogs.filter((log) => log.timestamp >= oneHourAgo).length,
      last24Hours: errorLogs.filter((log) => log.timestamp >= oneDayAgo).length,
      byType: this.buildAlertTypeMetrics(errorLogs),
    };
  }

  private async calculateTrends(timeRange: TimeRange) {
    const hours = timeRange === 'today' ? 24 : timeRange === 'week' ? 168 : 720;
    const hourlyStats = await this.getHourlyStats(hours);
    return { hourly: hourlyStats };
  }

  // ========================================
  // 趋势构建方法
  // ========================================

  private buildResponseTrend(
    records: MessageProcessingRecord[],
    timeRange: TimeRange,
  ): ResponseMinuteTrendPoint[] {
    return timeRange === 'today'
      ? this.buildBucketTrend(records, (r) => this.getMinuteKey(r.receivedAt))
      : this.buildBucketTrend(records, (r) => this.getDayKey(r.receivedAt));
  }

  private buildBucketTrend(
    records: MessageProcessingRecord[],
    keyFn: (r: MessageProcessingRecord) => string,
  ): ResponseMinuteTrendPoint[] {
    const buckets = new Map<string, { durations: number[]; success: number; total: number }>();

    for (const record of records) {
      if (record.status === 'processing' || record.totalDuration === undefined) continue;
      const key = keyFn(record);
      const bucket = buckets.get(key) || { durations: [], success: 0, total: 0 };
      bucket.durations.push(record.totalDuration || 0);
      bucket.total += 1;
      if (record.status === 'success') bucket.success += 1;
      buckets.set(key, bucket);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([minute, bucket]) => ({
        minute,
        avgDuration:
          bucket.durations.length > 0
            ? parseFloat(
                (bucket.durations.reduce((sum, v) => sum + v, 0) / bucket.durations.length).toFixed(
                  2,
                ),
              )
            : 0,
        messageCount: bucket.total,
        successRate:
          bucket.total > 0 ? parseFloat(((bucket.success / bucket.total) * 100).toFixed(2)) : 0,
      }));
  }

  private buildAlertTrend(logs: MonitoringErrorLog[], timeRange: TimeRange): AlertTrendPoint[] {
    const keyFn = timeRange === 'today' ? this.getMinuteKey : this.getDayKey;
    const buckets = new Map<string, number>();

    for (const log of logs) {
      const key = keyFn.call(this, log.timestamp);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([minute, count]) => ({ minute, count }));
  }

  private buildBusinessTrend(
    records: MessageProcessingRecord[],
    timeRange: TimeRange,
  ): BusinessMetricTrendPoint[] {
    const keyFn =
      timeRange === 'today'
        ? (r: MessageProcessingRecord) => this.getMinuteKey(r.receivedAt)
        : (r: MessageProcessingRecord) => this.getDayKey(r.receivedAt);

    const buckets = new Map<
      string,
      { users: Set<string>; bookingAttempts: number; successfulBookings: number }
    >();

    for (const record of records) {
      const key = keyFn(record);
      const bucket = buckets.get(key) || {
        users: new Set<string>(),
        bookingAttempts: 0,
        successfulBookings: 0,
      };

      if (record.userId) bucket.users.add(record.userId);

      const toolCalls = record.agentInvocation?.response?.toolCalls;
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          if (toolCall?.toolName !== 'duliday_interview_booking') continue;
          bucket.bookingAttempts += 1;
          if (this.checkBookingOutputSuccess(toolCall.result)) {
            bucket.successfulBookings += 1;
          }
        }
      } else {
        const chatResponse = record.agentInvocation?.response;
        if (chatResponse?.messages) {
          for (const message of chatResponse.messages) {
            if (!message.parts) continue;
            for (const part of message.parts) {
              if (part.type === 'dynamic-tool' && part.toolName === 'duliday_interview_booking') {
                bucket.bookingAttempts += 1;
                if (part.state === 'output-available' && part.output) {
                  if (this.checkBookingOutputSuccess(part.output)) {
                    bucket.successfulBookings += 1;
                  }
                }
              }
            }
          }
        }
      }

      buckets.set(key, bucket);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([minute, bucket]) => {
        const consultations = bucket.users.size;
        const bookingAttempts = bucket.bookingAttempts;
        const successfulBookings = bucket.successfulBookings;
        return {
          minute,
          consultations,
          bookingAttempts,
          successfulBookings,
          conversionRate:
            consultations > 0
              ? parseFloat(((bookingAttempts / consultations) * 100).toFixed(2))
              : 0,
          bookingSuccessRate:
            bookingAttempts > 0
              ? parseFloat(((successfulBookings / bookingAttempts) * 100).toFixed(2))
              : 0,
        };
      });
  }

  private buildAlertTypeMetrics(errorLogs: MonitoringErrorLog[]): AlertTypeMetric[] {
    const typeMap = new Map<AlertErrorType | 'unknown', number>();
    for (const log of errorLogs) {
      const type = log.alertType || 'unknown';
      typeMap.set(type, (typeMap.get(type) || 0) + 1);
    }
    const total = Array.from(typeMap.values()).reduce((acc, v) => acc + v, 0);
    if (total === 0) return [];
    return Array.from(typeMap.entries())
      .map(([type, count]) => ({
        type,
        count,
        percentage: parseFloat(((count / total) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.count - a.count);
  }

  private checkBookingOutputSuccess(output: unknown): boolean {
    if (!output || typeof output !== 'object') {
      return false;
    }

    if (
      (output as Record<string, unknown>).type === 'object' &&
      (output as Record<string, unknown>).object
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj = (output as Record<string, unknown>).object as any;
      return obj.success === true;
    }
    return (output as Record<string, unknown>).success === true;
  }

  // ========================================
  // 时间格式化
  // ========================================

  private getMinuteKey(timestamp: number): string {
    return formatLocalMinute(new Date(timestamp));
  }

  private getDayKey(timestamp: number): string {
    return formatLocalDate(new Date(timestamp));
  }
}

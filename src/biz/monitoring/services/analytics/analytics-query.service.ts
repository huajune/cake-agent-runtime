import { Injectable, Logger } from '@nestjs/common';
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
import { MessageProcessingRepository } from '@biz/message/repositories/message-processing.repository';
import { MonitoringHourlyStatsRepository } from '../../repositories/hourly-stats.repository';
import { MonitoringErrorLogRepository } from '../../repositories/error-log.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { MessageTrackingService } from '../tracking/message-tracking.service';
import * as os from 'os';

/**
 * 单项数据查询服务
 * 负责系统监控、趋势数据、指标、消息统计、用户等独立查询接口
 */
@Injectable()
export class AnalyticsQueryService {
  private readonly logger = new Logger(AnalyticsQueryService.name);

  private todayUsersCache: { value: TodayUser[]; expireAt: number } | null = null;

  constructor(
    private readonly messageProcessingRepository: MessageProcessingRepository,
    private readonly hourlyStatsRepository: MonitoringHourlyStatsRepository,
    private readonly errorLogRepository: MonitoringErrorLogRepository,
    private readonly userHostingService: UserHostingService,
    private readonly cacheService: MonitoringCacheService,
    private readonly messageTrackingService: MessageTrackingService,
  ) {}

  // ========================================
  // 系统监控 / 趋势 / 指标 / 消息统计
  // ========================================

  /**
   * 获取 System 监控数据（轻量级）
   */
  async getSystemMonitoringAsync(): Promise<{
    queue: { currentProcessing: number; peakProcessing: number; avgQueueDuration: number };
    alertsSummary: {
      total: number;
      lastHour: number;
      last24Hours: number;
      byType: AlertTypeMetric[];
    };
    alertTrend: AlertTrendPoint[];
  }> {
    try {
      const [currentRecords, errorLogs, globalCounters] = await Promise.all([
        this.getRecordsByTimeRange(Date.now() - 24 * 60 * 60 * 1000, Date.now()),
        this.getErrorLogsByTimeRange('today'),
        this.cacheService.getCounters(),
      ]);

      const queue = this.calculateQueueMetrics(currentRecords, globalCounters);
      const alertsSummary = this.calculateAlertsSummary(errorLogs);
      const alertTrend = this.buildAlertTrend(errorLogs, 'today');

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
      const timeRanges = this.calculateTimeRanges(timeRange);
      const { currentStart, currentEnd } = timeRanges;

      const [currentRecords, errorLogs, trends] = await Promise.all([
        this.getRecordsByTimeRange(currentStart, currentEnd),
        this.getErrorLogsByTimeRange(timeRange),
        this.calculateTrends(timeRange),
      ]);

      return {
        dailyTrend: trends,
        responseTrend: this.buildResponseTrend(currentRecords, timeRange),
        alertTrend: this.buildAlertTrend(errorLogs, timeRange),
        businessTrend: this.buildBusinessTrend(currentRecords, timeRange),
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

      const percentiles = this.calculatePercentilesFromArray(durations);

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
    return this.messageProcessingRepository.getMessageStats(startTime, endTime);
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
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const dbUsers = await this.messageProcessingRepository.getActiveUsers(todayStart, new Date());

    const chatIds = dbUsers.map((u) => u.chatId);
    const pausedSet = new Set<string>();

    for (const chatId of chatIds) {
      const status = await this.userHostingService.getUserHostingStatus(chatId);
      if (status.isPaused) {
        pausedSet.add(chatId);
      }
    }

    return dbUsers.map((user) => ({
      chatId: user.chatId,
      odId: user.userId || user.chatId,
      odName: user.userName || user.chatId,
      messageCount: user.messageCount,
      tokenUsage: user.tokenUsage,
      firstActiveAt: user.firstActiveAt,
      lastActiveAt: user.lastActiveAt,
      isPaused: pausedSet.has(user.chatId),
    }));
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

    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const dbUsers = await this.messageProcessingRepository.getActiveUsers(startDate, endDate);

    const chatIds = dbUsers.map((u) => u.chatId);
    const pausedSet = new Set<string>();

    for (const chatId of chatIds) {
      const status = await this.userHostingService.getUserHostingStatus(chatId);
      if (status.isPaused) {
        pausedSet.add(chatId);
      }
    }

    return dbUsers.map((user) => ({
      chatId: user.chatId,
      odId: user.userId || user.chatId,
      odName: user.userName || user.chatId,
      messageCount: user.messageCount,
      tokenUsage: user.tokenUsage,
      firstActiveAt: user.firstActiveAt,
      lastActiveAt: user.lastActiveAt,
      isPaused: pausedSet.has(user.chatId),
    }));
  }

  async getUserTrend(): Promise<Array<{ date: string; userCount: number; messageCount: number }>> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);
    const stats = await this.messageProcessingRepository.getDailyUserStats(startDate, endDate);
    return stats.map((s) => ({
      date: s.date,
      userCount: s.uniqueUsers,
      messageCount: s.messageCount,
    }));
  }

  public async getRecentDetailRecords(limit: number = 50): Promise<MessageProcessingRecord[]> {
    try {
      const result = await this.messageProcessingRepository.getMessageProcessingRecords({ limit });
      return result.records as unknown as MessageProcessingRecord[];
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
      const records = await this.messageProcessingRepository.getRecordsByTimeRange(
        startTime,
        endTime,
      );
      return records as unknown as MessageProcessingRecord[];
    } catch (error) {
      this.logger.error('按时间范围查询消息记录失败:', error);
      return [];
    }
  }

  private async getDetailRecordsByTimeRange(range: TimeRange): Promise<MessageProcessingRecord[]> {
    try {
      const cutoffTime = this.getTimeRangeCutoff(range);
      const limitByRange = { today: 2000, week: 5000, month: 10000 };
      const result = await this.messageProcessingRepository.getMessageProcessingRecords({
        startTime: cutoffTime.getTime(),
        limit: limitByRange[range] || 2000,
      });
      return result.records as unknown as MessageProcessingRecord[];
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

  private calculateTimeRanges(timeRange: TimeRange): {
    currentStart: number;
    currentEnd: number;
    previousStart: number;
    previousEnd: number;
  } {
    const now = Date.now();
    let currentStart: number;
    let currentEnd: number;
    let previousStart: number;
    let previousEnd: number;

    switch (timeRange) {
      case 'today': {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        currentStart = todayStart.getTime();
        currentEnd = now;
        const yesterdayStart = new Date(todayStart);
        yesterdayStart.setDate(yesterdayStart.getDate() - 1);
        previousStart = yesterdayStart.getTime();
        previousEnd = currentStart;
        break;
      }
      case 'week':
        currentStart = now - 7 * 24 * 60 * 60 * 1000;
        currentEnd = now;
        previousStart = currentStart - 7 * 24 * 60 * 60 * 1000;
        previousEnd = currentStart;
        break;
      case 'month':
        currentStart = now - 30 * 24 * 60 * 60 * 1000;
        currentEnd = now;
        previousStart = currentStart - 30 * 24 * 60 * 60 * 1000;
        previousEnd = currentStart;
        break;
      default:
        currentStart = now - 24 * 60 * 60 * 1000;
        currentEnd = now;
        previousStart = currentStart - 24 * 60 * 60 * 1000;
        previousEnd = currentStart;
    }

    return { currentStart, currentEnd, previousStart, previousEnd };
  }

  private getTimeRangeCutoff(range: TimeRange): Date {
    const now = new Date();
    switch (range) {
      case 'today':
        now.setHours(0, 0, 0, 0);
        return now;
      case 'week':
        now.setDate(now.getDate() - 7);
        return now;
      case 'month':
        now.setDate(now.getDate() - 30);
        return now;
      default:
        return now;
    }
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
      currentProcessing: this.messageTrackingService.getPendingCount(),
      peakProcessing: Math.max(...queueDurations, 0),
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
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
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
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
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

      buckets.set(key, bucket);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
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

  private checkBookingOutputSuccess(output: Record<string, unknown>): boolean {
    if (output.type === 'object' && output.object) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj = output.object as any;
      return obj.success === true;
    }
    return false;
  }

  // ========================================
  // 时间格式化
  // ========================================

  private getMinuteKey(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  private getDayKey(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

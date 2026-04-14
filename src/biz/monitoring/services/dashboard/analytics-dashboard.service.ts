import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsMetricsService } from '@analytics/metrics/analytics-metrics.service';
import { AnalyticsTrendBuilderService } from '@analytics/trends/analytics-trend-builder.service';
import { formatLocalDate } from '@infra/utils/date.util';
import {
  MessageProcessingRecord,
  MonitoringErrorLog,
  MonitoringGlobalCounters,
  AlertErrorType,
} from '@shared-types/tracking.types';
import {
  HourlyStats,
  DashboardData,
  ScenarioUsageMetric,
  ToolUsageMetric,
  ResponseMinuteTrendPoint,
  AlertTrendPoint,
  AlertTypeMetric,
  TimeRange,
  TodayUser,
  BusinessMetricTrendPoint,
  DashboardOverviewStats,
  DashboardFallbackStats,
  DailyStats,
  DailyTrendData,
} from '../../types/analytics.types';
import { MonitoringCacheService } from '../tracking/monitoring-cache.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { BookingService } from '@biz/message/services/booking.service';
import { MonitoringHourlyStatsRepository } from '../../repositories/hourly-stats.repository';
import { MonitoringErrorLogRepository } from '../../repositories/error-log.repository';
import { MonitoringRecordRepository } from '../../repositories/record.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { HourlyStatsAggregatorService } from '../projections/hourly-stats-aggregator.service';
import { MessageTrackingService } from '../tracking/message-tracking.service';

/** 业务指标快照（用户数 + 预约数 + 转化率） */
export interface BusinessMetricsSnapshot {
  consultations: { total: number; new: number };
  bookings: { attempts: number; successful: number; failed: number; successRate: number };
  conversion: { consultationToBooking: number };
}

/**
 * Dashboard 数据聚合服务
 * 负责仪表盘完整数据和概览数据的聚合计算
 */
@Injectable()
export class AnalyticsDashboardService {
  private readonly logger = new Logger(AnalyticsDashboardService.name);
  private readonly DEFAULT_WINDOW_HOURS = 24;

  constructor(
    private readonly messageProcessingService: MessageProcessingService,
    private readonly hourlyStatsRepository: MonitoringHourlyStatsRepository,
    private readonly errorLogRepository: MonitoringErrorLogRepository,
    private readonly userHostingService: UserHostingService,
    private readonly cacheService: MonitoringCacheService,
    private readonly monitoringRepository: MonitoringRecordRepository,
    private readonly bookingService: BookingService,
    private readonly hourlyStatsAggregator: HourlyStatsAggregatorService,
    private readonly messageTrackingService: MessageTrackingService,
    private readonly analyticsMetricsService: AnalyticsMetricsService,
    private readonly analyticsTrendBuilder: AnalyticsTrendBuilderService,
  ) {}

  // ========================================
  // Dashboard 数据接口
  // ========================================

  /**
   * 获取仪表盘数据（完整版）
   * @deprecated 建议使用 getDashboardOverviewAsync
   */
  async getDashboardDataAsync(timeRange: TimeRange = 'today'): Promise<DashboardData> {
    try {
      const timeRanges = this.calculateTimeRanges(timeRange);
      const { currentStart, currentEnd, previousStart, previousEnd } = timeRanges;

      const [currentRecords, previousRecords, recentMessages, errorLogs, todayUsers] =
        await Promise.all([
          this.getRecordsByTimeRange(currentStart, currentEnd),
          this.getRecordsByTimeRange(previousStart, previousEnd),
          this.getRecentDetailRecords(50),
          this.getErrorLogsByTimeRange(timeRange),
          timeRange === 'today' ? this.getTodayUsersFromDatabase() : Promise.resolve([]),
        ]);

      const overview = this.calculateOverview(currentRecords);
      const previousOverview = this.calculateOverview(previousRecords);
      const overviewDelta = this.calculateOverviewDelta(overview, previousOverview);

      const fallback = this.calculateFallbackStats(currentRecords);
      const previousFallback = this.calculateFallbackStats(previousRecords);
      const fallbackDelta = this.calculateFallbackDelta(fallback, previousFallback);

      const currentStartDate = formatLocalDate(new Date(currentStart));
      const currentEndDate = formatLocalDate(new Date(currentEnd));
      const previousStartDate = formatLocalDate(new Date(previousStart));
      const previousEndDate = formatLocalDate(new Date(previousEnd));

      const [business, previousBusiness] = await Promise.all([
        this.getBusinessMetricsFromDatabase(currentStartDate, currentEndDate, currentRecords),
        this.getBusinessMetricsFromDatabase(previousStartDate, previousEndDate, previousRecords),
      ]);
      const businessDelta = this.calculateBusinessDelta(business, previousBusiness);

      const usage = {
        tools: this.buildToolUsageMetrics(currentRecords),
        scenarios: this.buildScenarioUsageMetrics(currentRecords),
      };

      const queue = this.analyticsMetricsService.calculateQueueMetrics(
        currentRecords,
        this.messageTrackingService.getPendingCount(),
      );
      const alertsSummary = this.analyticsMetricsService.calculateAlertsSummary(errorLogs);
      const trends = await this.calculateTrends(timeRange);
      const responseTrend = this.analyticsTrendBuilder.buildResponseTrend(
        currentRecords,
        timeRange,
      );
      const alertTrend = this.analyticsTrendBuilder.buildAlertTrend(errorLogs, timeRange);
      const businessTrend = this.analyticsTrendBuilder.buildBusinessTrend(
        currentRecords,
        timeRange,
      );

      return {
        timeRange,
        lastWindowHours: this.DEFAULT_WINDOW_HOURS,
        overview,
        overviewDelta,
        fallback,
        fallbackDelta,
        business,
        businessDelta,
        usage,
        queue,
        alertsSummary,
        trends,
        responseTrend,
        alertTrend,
        businessTrend,
        todayUsers,
        recentMessages,
        recentErrors: errorLogs,
        realtime: {
          processingCount: this.messageTrackingService.getPendingCount(),
        },
      };
    } catch (error) {
      this.logger.error('获取Dashboard数据失败:', error);
      return this.getEmptyDashboardData(timeRange);
    }
  }

  /**
   * 获取 Dashboard 概览数据（优化版 - 使用 SQL 聚合查询）
   */
  async getDashboardOverviewAsync(timeRange: TimeRange = 'today'): Promise<{
    timeRange: string;
    overview: DashboardOverviewStats & { activeUsers: number; activeChats: number };
    overviewDelta: {
      totalMessages: number;
      successRate: number;
      avgDuration: number;
      activeUsers: number;
    };
    dailyTrend: DailyStats[];
    tokenTrend: { time: string; tokenUsage: number; messageCount: number }[];
    businessTrend: BusinessMetricTrendPoint[];
    responseTrend: ResponseMinuteTrendPoint[];
    business: BusinessMetricsSnapshot;
    businessDelta: { consultations: number; bookingAttempts: number; bookingSuccessRate: number };
    fallback: DashboardFallbackStats;
    fallbackDelta: { totalCount: number; successRate: number };
  }> {
    try {
      const timeRanges = this.calculateTimeRanges(timeRange);
      const { currentStart, currentEnd, previousStart, previousEnd } = timeRanges;

      const currentStartDate = new Date(currentStart);
      const currentEndDate = new Date(currentEnd);
      const previousStartDate = new Date(previousStart);
      const previousEndDate = new Date(previousEnd);

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      sevenDaysAgo.setHours(0, 0, 0, 0);
      const currentHourStart = this.getHourStart(currentEndDate);
      const hourlyProjectionFresh = await this.isHourlyProjectionFresh(currentEndDate);

      let currentOverview: DashboardOverviewStats;
      let previousOverview: DashboardOverviewStats;
      let currentFallback: DashboardFallbackStats;
      let previousFallback: DashboardFallbackStats;
      let dailyTrend: DailyTrendData[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let minuteTrend: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let tokenTrendData: any[];

      if (!hourlyProjectionFresh) {
        this.logger.warn(
          `[Dashboard] 小时聚合数据断更，回退到原始记录查询: range=${timeRange}, currentEnd=${currentEndDate.toISOString()}`,
        );

        if (timeRange === 'today') {
          const [curOverview, prevOverview, curFallback, prevFallback, daily, minute, tokenTrend] =
            await Promise.all([
              this.monitoringRepository.getDashboardOverviewStats(currentStartDate, currentEndDate),
              this.monitoringRepository.getDashboardOverviewStats(
                previousStartDate,
                previousEndDate,
              ),
              this.monitoringRepository.getDashboardFallbackStats(currentStartDate, currentEndDate),
              this.monitoringRepository.getDashboardFallbackStats(
                previousStartDate,
                previousEndDate,
              ),
              this.monitoringRepository.getDashboardDailyTrend(sevenDaysAgo, currentEndDate),
              this.monitoringRepository.getDashboardMinuteTrend(
                currentStartDate,
                currentEndDate,
                5,
              ),
              this.monitoringRepository.getDashboardHourlyTrend(currentStartDate, currentEndDate),
            ]);

          currentOverview = curOverview;
          previousOverview = prevOverview;
          currentFallback = curFallback;
          previousFallback = prevFallback;
          dailyTrend = daily;
          minuteTrend = minute;
          tokenTrendData = tokenTrend;
        } else {
          const [curOverview, prevOverview, curFallback, prevFallback, daily, currentPeriodDaily] =
            await Promise.all([
              this.monitoringRepository.getDashboardOverviewStats(currentStartDate, currentEndDate),
              this.monitoringRepository.getDashboardOverviewStats(
                previousStartDate,
                previousEndDate,
              ),
              this.monitoringRepository.getDashboardFallbackStats(currentStartDate, currentEndDate),
              this.monitoringRepository.getDashboardFallbackStats(
                previousStartDate,
                previousEndDate,
              ),
              this.monitoringRepository.getDashboardDailyTrend(sevenDaysAgo, currentEndDate),
              this.monitoringRepository.getDashboardDailyTrend(currentStartDate, currentEndDate),
            ]);

          currentOverview = curOverview;
          previousOverview = prevOverview;
          currentFallback = curFallback;
          previousFallback = prevFallback;
          dailyTrend = daily;
          minuteTrend = currentPeriodDaily;
          tokenTrendData = currentPeriodDaily;
        }
      } else if (timeRange === 'today') {
        const [
          historicalOverview,
          realtimeOverview,
          historicalFallback,
          realtimeFallback,
          prevOverview,
          prevFallback,
          daily,
          minute,
          historicalTokenTrend,
          realtimeTokenTrend,
        ] = await Promise.all([
          this.hourlyStatsAggregator.getOverviewFromHourly(currentStartDate, currentHourStart),
          this.monitoringRepository.getDashboardOverviewStats(currentHourStart, currentEndDate),
          this.hourlyStatsAggregator.getFallbackFromHourly(currentStartDate, currentHourStart),
          this.monitoringRepository.getDashboardFallbackStats(currentHourStart, currentEndDate),
          this.hourlyStatsAggregator.getOverviewFromHourly(previousStartDate, previousEndDate),
          this.hourlyStatsAggregator.getFallbackFromHourly(previousStartDate, previousEndDate),
          this.hourlyStatsAggregator.getDailyTrendFromHourly(sevenDaysAgo, currentEndDate),
          this.monitoringRepository.getDashboardMinuteTrend(currentStartDate, currentEndDate, 5),
          this.hourlyStatsAggregator.getHourlyTrendFromHourly(currentStartDate, currentHourStart),
          this.monitoringRepository.getDashboardHourlyTrend(currentHourStart, currentEndDate),
        ]);

        currentOverview = this.hourlyStatsAggregator.mergeOverviewStats(
          historicalOverview,
          realtimeOverview,
        );
        currentFallback = this.hourlyStatsAggregator.mergeFallbackStats(
          historicalFallback,
          realtimeFallback,
        );
        previousOverview = prevOverview;
        previousFallback = prevFallback;
        dailyTrend = daily;
        minuteTrend = minute;
        tokenTrendData = [...historicalTokenTrend, ...realtimeTokenTrend];
      } else {
        const [curOverview, prevOverview, curFallback, prevFallback, daily, currentPeriodDaily] =
          await Promise.all([
            this.hourlyStatsAggregator.getOverviewFromHourly(currentStartDate, currentEndDate),
            this.hourlyStatsAggregator.getOverviewFromHourly(previousStartDate, previousEndDate),
            this.hourlyStatsAggregator.getFallbackFromHourly(currentStartDate, currentEndDate),
            this.hourlyStatsAggregator.getFallbackFromHourly(previousStartDate, previousEndDate),
            this.hourlyStatsAggregator.getDailyTrendFromHourly(sevenDaysAgo, currentEndDate),
            this.hourlyStatsAggregator.getDailyTrendFromHourly(currentStartDate, currentEndDate),
          ]);

        currentOverview = curOverview;
        previousOverview = prevOverview;
        currentFallback = curFallback;
        previousFallback = prevFallback;
        dailyTrend = daily;
        minuteTrend = currentPeriodDaily;
        tokenTrendData = currentPeriodDaily;
      }

      const overview = {
        totalMessages: currentOverview.totalMessages,
        successCount: currentOverview.successCount,
        failureCount: currentOverview.failureCount,
        successRate: currentOverview.successRate,
        avgDuration: currentOverview.avgDuration,
        activeUsers: currentOverview.activeUsers,
        activeChats: currentOverview.activeChats,
        totalTokenUsage: currentOverview.totalTokenUsage,
      };

      const overviewDelta = {
        totalMessages: this.calculatePercentChange(
          currentOverview.totalMessages,
          previousOverview.totalMessages,
        ),
        successRate: parseFloat(
          (currentOverview.successRate - previousOverview.successRate).toFixed(2),
        ),
        avgDuration: this.calculatePercentChange(
          currentOverview.avgDuration,
          previousOverview.avgDuration,
        ),
        activeUsers: this.calculatePercentChange(
          currentOverview.activeUsers,
          previousOverview.activeUsers,
        ),
      };

      const fallback = {
        totalCount: currentFallback.totalCount,
        successCount: currentFallback.successCount,
        successRate: currentFallback.successRate,
        affectedUsers: currentFallback.affectedUsers,
      };

      const fallbackDelta = {
        totalCount: this.calculatePercentChange(
          currentFallback.totalCount,
          previousFallback.totalCount,
        ),
        successRate: parseFloat(
          (currentFallback.successRate - previousFallback.successRate).toFixed(2),
        ),
      };

      const curStartDate = formatLocalDate(currentStartDate);
      const curEndDate = formatLocalDate(currentEndDate);
      const prevStartDate = formatLocalDate(previousStartDate);
      const prevEndDate = formatLocalDate(previousEndDate);

      // 并行查询：预约数（轻量索引查询）+ 趋势原始记录（仅当期，用于图表）
      const [currentBookings, previousBookings, trendRecords] = await Promise.all([
        this.getBookingCount(curStartDate, curEndDate),
        this.getBookingCount(prevStartDate, prevEndDate),
        this.getDetailRecordsByTimeRange(timeRange),
      ]);

      // 用户数直接复用 overview 的 activeUsers（来自 SQL COUNT DISTINCT）
      // 注：跨小时聚合的 activeUsers 是 sum（可能重复计数），但与旧版行为一致
      const business = this.buildBusinessFromStats(currentOverview.activeUsers, currentBookings);
      const previousBusiness = this.buildBusinessFromStats(
        previousOverview.activeUsers,
        previousBookings,
      );
      const businessDelta = this.calculateBusinessDelta(business, previousBusiness);

      const formattedDailyTrend: DailyStats[] = dailyTrend.map((item) => ({
        date: item.date,
        messageCount: item.messageCount,
        successCount: item.successCount,
        avgDuration: item.avgDuration,
        tokenUsage: item.tokenUsage,
        uniqueUsers: item.uniqueUsers,
      }));

      const responseTrend =
        timeRange === 'today'
          ? (
              minuteTrend as {
                minute: string;
                avgDuration: number;
                messageCount: number;
                successCount: number;
              }[]
            ).map((item) => ({
              minute: item.minute,
              avgDuration: item.avgDuration,
              messageCount: item.messageCount,
              successRate:
                item.messageCount > 0
                  ? parseFloat(((item.successCount / item.messageCount) * 100).toFixed(2))
                  : 0,
            }))
          : (
              minuteTrend as {
                date: string;
                avgDuration: number;
                messageCount: number;
                successCount: number;
              }[]
            ).map((item) => ({
              minute: item.date,
              avgDuration: item.avgDuration,
              messageCount: item.messageCount,
              successRate:
                item.messageCount > 0
                  ? parseFloat(((item.successCount / item.messageCount) * 100).toFixed(2))
                  : 0,
            }));

      const businessTrend = this.analyticsTrendBuilder.buildBusinessTrend(trendRecords, timeRange);

      const tokenTrend =
        timeRange === 'today'
          ? (tokenTrendData as { hour: string; tokenUsage: number; messageCount: number }[]).map(
              (item) => ({
                time: item.hour,
                tokenUsage: item.tokenUsage,
                messageCount: item.messageCount,
              }),
            )
          : (tokenTrendData as { date: string; tokenUsage: number; messageCount: number }[]).map(
              (item) => ({
                time: item.date,
                tokenUsage: item.tokenUsage,
                messageCount: item.messageCount,
              }),
            );

      return {
        timeRange,
        overview,
        overviewDelta,
        dailyTrend: formattedDailyTrend,
        tokenTrend,
        businessTrend,
        responseTrend,
        business,
        businessDelta,
        fallback,
        fallbackDelta,
      };
    } catch (error) {
      this.logger.error('获取Dashboard概览数据失败:', error);
      throw error;
    }
  }

  private getHourStart(date: Date): Date {
    const hourStart = new Date(date);
    hourStart.setMinutes(0, 0, 0);
    return hourStart;
  }

  private async isHourlyProjectionFresh(currentEndDate: Date): Promise<boolean> {
    try {
      const latestHourly = await this.hourlyStatsRepository.getLatestHourlyStat();

      if (!latestHourly?.hour) {
        return false;
      }

      const expectedLatestCompletedHour = this.getHourStart(currentEndDate);
      expectedLatestCompletedHour.setHours(expectedLatestCompletedHour.getHours() - 1);

      return new Date(latestHourly.hour).getTime() >= expectedLatestCompletedHour.getTime();
    } catch (error) {
      this.logger.warn('[Dashboard] 检查小时聚合新鲜度失败，回退到原始记录查询:', error);
      return false;
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
      return records as unknown as MessageProcessingRecord[];
    } catch (error) {
      this.logger.error('按时间范围查询消息记录失败:', error);
      return [];
    }
  }

  private async getRecentDetailRecords(limit: number = 50): Promise<MessageProcessingRecord[]> {
    try {
      const result = await this.messageProcessingService.getRecordsByTimestamps({ limit });
      return result.records as unknown as MessageProcessingRecord[];
    } catch (error) {
      this.logger.error('查询最近消息记录异常:', error);
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

  private async getTodayUsersFromDatabase(): Promise<TodayUser[]> {
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const dbUsers = await this.messageProcessingService.getActiveUsers(todayStart, new Date());

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
    } catch (error) {
      this.logger.error('查询今日用户失败:', error);
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

  private calculatePercentChange(current: number, previous: number): number {
    if (previous === 0) return current === 0 ? 0 : 100;
    return parseFloat((((current - previous) / previous) * 100).toFixed(2));
  }

  private calculateOverview(records: MessageProcessingRecord[]) {
    const totalMessages = records.length;
    const successCount = records.filter((r) => r.status === 'success').length;
    const failureCount = totalMessages - successCount;
    const successRate = totalMessages > 0 ? (successCount / totalMessages) * 100 : 0;
    const durations = records.filter((r) => r.totalDuration).map((r) => r.totalDuration!);
    const avgDuration =
      durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
    const activeChats = new Set(records.map((r) => r.chatId)).size;

    return {
      totalMessages,
      successCount,
      failureCount,
      successRate: parseFloat(successRate.toFixed(2)),
      avgDuration: parseFloat(avgDuration.toFixed(0)),
      activeChats,
    };
  }

  private calculateOverviewDelta(
    current: ReturnType<typeof this.calculateOverview>,
    previous: ReturnType<typeof this.calculateOverview>,
  ) {
    return {
      totalMessages: this.calculatePercentChange(current.totalMessages, previous.totalMessages),
      successRate: parseFloat((current.successRate - previous.successRate).toFixed(2)),
      avgDuration: this.calculatePercentChange(current.avgDuration, previous.avgDuration),
    };
  }

  private calculateFallbackStats(records: MessageProcessingRecord[]) {
    const fallbackRecords = records.filter((r) => r.isFallback === true);
    const totalCount = fallbackRecords.length;
    const successCount = fallbackRecords.filter((r) => r.fallbackSuccess === true).length;
    const successRate = totalCount > 0 ? (successCount / totalCount) * 100 : 0;
    const affectedUsers = new Set(fallbackRecords.filter((r) => r.userId).map((r) => r.userId!))
      .size;

    return {
      totalCount,
      successCount,
      successRate: parseFloat(successRate.toFixed(2)),
      affectedUsers,
    };
  }

  private calculateFallbackDelta(
    current: ReturnType<typeof this.calculateFallbackStats>,
    previous: ReturnType<typeof this.calculateFallbackStats>,
  ) {
    return {
      totalCount: this.calculatePercentChange(current.totalCount, previous.totalCount),
      successRate: parseFloat((current.successRate - previous.successRate).toFixed(2)),
    };
  }

  private async getBusinessMetricsFromDatabase(
    startDate: string,
    endDate: string,
    records: MessageProcessingRecord[],
  ) {
    const users = new Set(records.filter((r) => r.userId).map((r) => r.userId!));

    let successfulBookings = 0;
    try {
      const bookingStats = await this.bookingService.getBookingStats({ startDate, endDate });
      successfulBookings = bookingStats.reduce((sum, item) => sum + item.bookingCount, 0);
    } catch (error) {
      this.logger.warn('[业务指标] 获取预约统计失败，使用默认值 0:', error);
    }

    const bookingAttempts = successfulBookings;
    const bookingSuccessRate = bookingAttempts > 0 ? 100 : 0;
    const conversionRate = users.size > 0 ? (bookingAttempts / users.size) * 100 : 0;

    return {
      consultations: { total: users.size, new: users.size },
      bookings: {
        attempts: bookingAttempts,
        successful: successfulBookings,
        failed: 0,
        successRate: parseFloat(bookingSuccessRate.toFixed(2)),
      },
      conversion: { consultationToBooking: parseFloat(conversionRate.toFixed(2)) },
    };
  }

  private calculateBusinessMetrics(records: MessageProcessingRecord[]): BusinessMetricsSnapshot {
    const users = new Set(records.filter((r) => r.userId).map((r) => r.userId!));
    return {
      consultations: { total: users.size, new: users.size },
      bookings: { attempts: 0, successful: 0, failed: 0, successRate: 0 },
      conversion: { consultationToBooking: 0 },
    };
  }

  /**
   * 从预聚合的用户数和预约数构建业务指标（无需加载全量 records）
   */
  private buildBusinessFromStats(
    activeUsers: number,
    bookingCount: number,
  ): BusinessMetricsSnapshot {
    // 只有预约总数（attempts），无成功/失败拆分数据，故 successful/failed/successRate 均为 0
    const conversionRate = activeUsers > 0 ? (bookingCount / activeUsers) * 100 : 0;
    return {
      consultations: { total: activeUsers, new: activeUsers },
      bookings: {
        attempts: bookingCount,
        successful: 0,
        failed: 0,
        successRate: 0,
      },
      conversion: { consultationToBooking: parseFloat(conversionRate.toFixed(2)) },
    };
  }

  /**
   * 轻量查询：获取指定日期范围的预约总数
   */
  private async getBookingCount(startDate: string, endDate: string): Promise<number> {
    try {
      const bookingStats = await this.bookingService.getBookingStats({ startDate, endDate });
      return bookingStats.reduce((sum, item) => sum + item.bookingCount, 0);
    } catch (error) {
      this.logger.warn('[业务指标] 获取预约统计失败，使用默认值 0:', error);
      return 0;
    }
  }

  private calculateBusinessDelta(
    current: BusinessMetricsSnapshot,
    previous: BusinessMetricsSnapshot,
  ) {
    return {
      consultations: this.calculatePercentChange(
        current.consultations.total,
        previous.consultations.total,
      ),
      bookingAttempts: this.calculatePercentChange(
        current.bookings.attempts,
        previous.bookings.attempts,
      ),
      bookingSuccessRate: parseFloat(
        (current.bookings.successRate - previous.bookings.successRate).toFixed(2),
      ),
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

  buildBusinessTrend(
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

  private buildToolUsageMetrics(records: MessageProcessingRecord[]): ToolUsageMetric[] {
    const toolMap = new Map<string, number>();
    for (const record of records) {
      if (!record.tools || record.tools.length === 0) continue;
      for (const tool of record.tools) {
        toolMap.set(tool, (toolMap.get(tool) || 0) + 1);
      }
    }
    const total = Array.from(toolMap.values()).reduce((acc, val) => acc + val, 0);
    if (total === 0) return [];
    return Array.from(toolMap.entries())
      .map(([name, count]) => ({
        name,
        total: count,
        percentage: parseFloat(((count / total) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.total - a.total);
  }

  private buildScenarioUsageMetrics(records: MessageProcessingRecord[]): ScenarioUsageMetric[] {
    const map = new Map<string, number>();
    for (const record of records) {
      if (!record.scenario) continue;
      map.set(record.scenario, (map.get(record.scenario) || 0) + 1);
    }
    const total = Array.from(map.values()).reduce((acc, v) => acc + v, 0);
    if (total === 0) return [];
    return Array.from(map.entries())
      .map(([name, count]) => ({
        name,
        total: count,
        percentage: parseFloat(((count / total) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.total - a.total);
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

  // ========================================
  // 空数据模板
  // ========================================

  private getEmptyDashboardData(timeRange: TimeRange): DashboardData {
    return {
      timeRange,
      lastWindowHours: this.DEFAULT_WINDOW_HOURS,
      overview: {
        totalMessages: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        avgDuration: 0,
        activeChats: 0,
      },
      overviewDelta: { totalMessages: 0, successRate: 0, avgDuration: 0 },
      fallback: { totalCount: 0, successCount: 0, successRate: 0, affectedUsers: 0 },
      fallbackDelta: { totalCount: 0, successRate: 0 },
      business: {
        consultations: { total: 0, new: 0 },
        bookings: { attempts: 0, successful: 0, failed: 0, successRate: 0 },
        conversion: { consultationToBooking: 0 },
      },
      businessDelta: { consultations: 0, bookingAttempts: 0, bookingSuccessRate: 0 },
      usage: { tools: [], scenarios: [] },
      queue: { currentProcessing: 0, peakProcessing: 0, avgQueueDuration: 0 },
      alertsSummary: { total: 0, lastHour: 0, last24Hours: 0, byType: [] },
      trends: { hourly: [] },
      responseTrend: [],
      alertTrend: [],
      businessTrend: [],
      todayUsers: [],
      recentMessages: [],
      recentErrors: [],
      realtime: { processingCount: 0 },
    };
  }
}

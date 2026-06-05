import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsMetricsService } from '@analytics/metrics/analytics-metrics.service';
import { AnalyticsTrendBuilderService } from '@analytics/trends/analytics-trend-builder.service';
import {
  addLocalDays,
  formatLocalDate,
  formatLocalMinute,
  getLocalDayStart,
  getLocalHourStart,
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
  DashboardManualInterventionStats,
  DailyStats,
  DailyTrendData,
} from '../../types/analytics.types';
import { MonitoringCacheService } from '../tracking/monitoring-cache.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { BookingService } from '@biz/message/services/booking.service';
import { DailyOpsReportRepository } from '@biz/ops-events/daily-ops-report.repository';
import { MonitoringHourlyStatsRepository } from '../../repositories/hourly-stats.repository';
import { MonitoringDailyStatsRepository } from '../../repositories/daily-stats.repository';
import { MonitoringErrorLogRepository } from '../../repositories/error-log.repository';
import { MonitoringRecordRepository } from '../../repositories/record.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { DailyStatsAggregatorService } from '../projections/daily-stats-aggregator.service';
import { HourlyStatsAggregatorService } from '../projections/hourly-stats-aggregator.service';
import { MessageTrackingService } from '../tracking/message-tracking.service';
import { MessageProcessor } from '@wecom/message/runtime/message.processor';
import {
  calculateDashboardTimeRanges,
  getDashboardTimeRangeCutoff,
  toMessageProcessingRecords,
} from './analytics-dashboard.util';

/** 业务指标快照（用户数 + 预约数 + 转化率） */
export interface BusinessMetricsSnapshot {
  consultations: { total: number; new: number };
  bookings: { attempts: number; successful: number; failed: number; successRate: number };
  conversion: { consultationToBooking: number };
}

type DashboardOverviewResponse = {
  timeRange: string;
  overview: DashboardOverviewStats & { activeUsers: number; activeChats: number };
  overviewDelta: {
    totalMessages: number;
    successRate: number;
    avgDuration: number;
  };
  dailyTrend: DailyStats[];
  tokenTrend: { time: string; tokenUsage: number; messageCount: number }[];
  businessTrend: BusinessMetricTrendPoint[];
  responseTrend: ResponseMinuteTrendPoint[];
  business: BusinessMetricsSnapshot;
  businessDelta: { consultations: number; bookingAttempts: number; bookingSuccessRate: number };
  fallback: DashboardFallbackStats;
  fallbackDelta: { totalCount: number; successRate: number };
  manualIntervention: DashboardManualInterventionStats;
};

const EMPTY_MANUAL_INTERVENTION_STATS: DashboardManualInterventionStats = {
  totalCount: 0,
  handoffCount: 0,
  riskAlertCount: 0,
};

const DETAIL_RECORD_LIMIT_BY_RANGE: Record<TimeRange, number> = {
  today: 2000,
  week: 5000,
  month: 10000,
  twoMonths: 20000,
  threeMonths: 30000,
};

const TREND_HOURS_BY_RANGE: Record<TimeRange, number> = {
  today: 24,
  week: 168,
  month: 720,
  twoMonths: 1440,
  threeMonths: 2160,
};

/**
 * Dashboard 数据聚合服务
 * 负责仪表盘完整数据和概览数据的聚合计算
 */
@Injectable()
export class AnalyticsDashboardService {
  private readonly logger = new Logger(AnalyticsDashboardService.name);
  private readonly DEFAULT_WINDOW_HOURS = 24;
  /** 活跃用户口径：近 1 小时内有消息往来的去重用户（实时脉搏，独立于所选时间范围） */
  private readonly ACTIVE_USER_WINDOW_MS = 60 * 60 * 1000;
  private readonly overviewCache = new Map<
    string,
    { expireAt: number; value: DashboardOverviewResponse }
  >();

  constructor(
    private readonly messageProcessingService: MessageProcessingService,
    private readonly dailyStatsRepository: MonitoringDailyStatsRepository,
    private readonly hourlyStatsRepository: MonitoringHourlyStatsRepository,
    private readonly errorLogRepository: MonitoringErrorLogRepository,
    private readonly userHostingService: UserHostingService,
    private readonly cacheService: MonitoringCacheService,
    private readonly monitoringRepository: MonitoringRecordRepository,
    private readonly bookingService: BookingService,
    private readonly dailyStatsAggregator: DailyStatsAggregatorService,
    private readonly hourlyStatsAggregator: HourlyStatsAggregatorService,
    private readonly messageTrackingService: MessageTrackingService,
    private readonly messageProcessor: MessageProcessor,
    private readonly analyticsMetricsService: AnalyticsMetricsService,
    private readonly analyticsTrendBuilder: AnalyticsTrendBuilderService,
    private readonly dailyOpsReportRepository: DailyOpsReportRepository,
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
      const timeRanges = calculateDashboardTimeRanges(timeRange);
      const { currentStart, currentEnd, previousStart, previousEnd } = timeRanges;

      const [
        currentRecords,
        previousRecords,
        recentMessages,
        errorLogs,
        todayUsers,
        activeRequests,
        peakActiveRequests,
        queueStatus,
      ] = await Promise.all([
        this.getRecordsByTimeRange(currentStart, currentEnd),
        this.getRecordsByTimeRange(previousStart, previousEnd),
        this.getRecentDetailRecords(50),
        this.getErrorLogsByTimeRange(timeRange),
        timeRange === 'today' ? this.getTodayUsersFromDatabase() : Promise.resolve([]),
        this.messageTrackingService.getActiveRequests(),
        this.messageTrackingService.getPeakActiveRequests(),
        this.messageProcessor.getQueueStatus(),
      ]);

      const overview = this.calculateOverview(currentRecords);
      const previousOverview = this.calculateOverview(previousRecords);
      const overviewDelta = this.calculateOverviewDelta(overview, previousOverview);

      const fallback = this.calculateFallbackStats(currentRecords);
      const previousFallback = this.calculateFallbackStats(previousRecords);
      const fallbackDelta = this.calculateFallbackDelta(fallback, previousFallback);
      const manualIntervention = this.calculateManualInterventionStats(currentRecords);

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

      const queue = this.analyticsMetricsService.calculateQueueMetrics(currentRecords, {
        activeRequests,
        peakActiveRequests,
        queueWaitingJobs: queueStatus.waiting,
      });
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
        manualIntervention,
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
          activeRequests,
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
  async getDashboardOverviewAsync(
    timeRange: TimeRange = 'today',
    groups: string[] = [],
  ): Promise<DashboardOverviewResponse> {
    try {
      const normalizedGroups = this.normalizeGroups(groups);
      if (normalizedGroups.length > 0) {
        return this.getDashboardOverviewByGroups(timeRange, normalizedGroups);
      }

      const cached = this.getCachedDashboardOverview(timeRange, normalizedGroups);
      if (cached) {
        return cached;
      }

      const timeRanges = calculateDashboardTimeRanges(timeRange);
      const { currentStart, currentEnd, previousStart, previousEnd } = timeRanges;

      const currentStartDate = new Date(currentStart);
      const currentEndDate = new Date(currentEnd);
      const previousStartDate = new Date(previousStart);
      const previousEndDate = new Date(previousEnd);

      const sevenDaysAgo = addLocalDays(getLocalDayStart(currentEndDate), -6);
      const currentHourStart = this.getHourStart(currentEndDate);
      const hourlyProjectionFresh = await this.isHourlyProjectionFresh(currentEndDate);
      const dailyProjectionFresh = await this.isDailyProjectionFresh(currentEndDate);

      // 活跃用户口径：近 1 小时内有消息往来的去重用户，与所选时间范围解耦（固定 1h 滚动窗口）
      const activeUserWindowStart = new Date(Date.now() - this.ACTIVE_USER_WINDOW_MS);
      const activeUserWindowEnd = new Date();

      const [
        currentOverview,
        previousOverview,
        currentFallback,
        previousFallback,
        manualIntervention,
        lastHourOverview,
      ] = await Promise.all([
        this.getOverviewStatsForRange(
          currentStartDate,
          currentEndDate,
          timeRange === 'today',
          dailyProjectionFresh,
        ),
        this.getOverviewStatsForRange(
          previousStartDate,
          previousEndDate,
          timeRange === 'today',
          dailyProjectionFresh,
        ),
        this.monitoringRepository.getDashboardFallbackStats(currentStartDate, currentEndDate),
        this.monitoringRepository.getDashboardFallbackStats(previousStartDate, previousEndDate),
        this.getManualInterventionStatsFromDatabase(currentStartDate, currentEndDate),
        // 近 1 小时活跃用户始终走实时（1h 滚动窗口，与所选范围解耦）。
        this.monitoringRepository.getDashboardOverviewStats(
          activeUserWindowStart,
          activeUserWindowEnd,
        ),
      ]);

      // 卡片展示用「近 1 小时活跃用户」；currentOverview.activeUsers（范围内去重用户数）
      // 仍保留给业务计算（咨询转化率分母 / 托管用户本日兜底）使用，避免被 1h 口径污染。
      const activeUsersLastHour = lastHourOverview.activeUsers;

      let dailyTrend: DailyTrendData[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let minuteTrend: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let tokenTrendData: any[];

      if (timeRange === 'today') {
        dailyTrend = dailyProjectionFresh
          ? await this.getDailyTrendFromProjectionRange(sevenDaysAgo, currentEndDate)
          : await this.monitoringRepository.getDashboardDailyTrend(sevenDaysAgo, currentEndDate);

        minuteTrend = await this.monitoringRepository.getDashboardMinuteTrend(
          currentStartDate,
          currentEndDate,
          5,
        );

        if (!hourlyProjectionFresh) {
          this.logger.warn(
            `[Dashboard] 小时聚合数据断更，回退到原始记录查询: range=${timeRange}, currentEnd=${currentEndDate.toISOString()}`,
          );
          tokenTrendData = await this.monitoringRepository.getDashboardHourlyTrend(
            currentStartDate,
            currentEndDate,
          );
        } else {
          const [historicalTokenTrend, realtimeTokenTrend] = await Promise.all([
            this.hourlyStatsAggregator.getHourlyTrendFromHourly(currentStartDate, currentHourStart),
            this.monitoringRepository.getDashboardHourlyTrend(currentHourStart, currentEndDate),
          ]);
          tokenTrendData = [...historicalTokenTrend, ...realtimeTokenTrend];
        }
      } else if (!dailyProjectionFresh) {
        this.logger.warn(
          `[Dashboard] 日聚合数据断更，回退到原始记录查询: range=${timeRange}, currentEnd=${currentEndDate.toISOString()}`,
        );

        const [daily, currentPeriodDaily] = await Promise.all([
          this.monitoringRepository.getDashboardDailyTrend(sevenDaysAgo, currentEndDate),
          this.monitoringRepository.getDashboardDailyTrend(currentStartDate, currentEndDate),
        ]);

        dailyTrend = daily;
        minuteTrend = currentPeriodDaily;
        tokenTrendData = currentPeriodDaily;
      } else {
        const [daily, currentPeriodDaily] = await Promise.all([
          this.getDailyTrendFromProjectionRange(sevenDaysAgo, currentEndDate),
          this.getDailyTrendFromProjectionRange(currentStartDate, currentEndDate),
        ]);

        dailyTrend = daily;
        minuteTrend = currentPeriodDaily;
        tokenTrendData = currentPeriodDaily;
      }

      if (!hourlyProjectionFresh && timeRange !== 'today') {
        this.logger.warn(
          `[Dashboard] 小时聚合数据断更，回退到原始记录查询: range=${timeRange}, currentEnd=${currentEndDate.toISOString()}`,
        );
      }

      if (
        timeRange !== 'today' &&
        currentOverview.totalMessages > 0 &&
        (minuteTrend.length === 0 || tokenTrendData.length === 0)
      ) {
        const recoveredDailyTrend = await this.recoverCurrentPeriodDailyTrend(
          currentStartDate,
          currentEndDate,
          timeRange,
        );

        if (recoveredDailyTrend.length > 0) {
          if (minuteTrend.length === 0) {
            minuteTrend = recoveredDailyTrend;
          }
          if (tokenTrendData.length === 0) {
            tokenTrendData = recoveredDailyTrend;
          }
        }
      }

      const overview = {
        totalMessages: currentOverview.totalMessages,
        successCount: currentOverview.successCount,
        failureCount: currentOverview.failureCount,
        successRate: currentOverview.successRate,
        avgDuration: currentOverview.avgDuration,
        activeUsers: activeUsersLastHour,
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

      // 并行查询：预约数（轻量索引查询）+ 业务趋势（数据库侧聚合，避免拉取原始流水）
      const [
        currentBookings,
        previousBookings,
        rawBusinessTrend,
        currentManagedUsers,
        previousManagedUsers,
      ] = await Promise.all([
        this.getBookingCount(curStartDate, curEndDate),
        this.getBookingCount(prevStartDate, prevEndDate),
        this.getBusinessTrendFromDatabase(
          currentStart,
          currentEnd,
          currentOverview.activeUsers,
          timeRange,
        ),
        this.getManagedUserCountForBusiness(
          currentStartDate,
          currentEndDate,
          currentOverview.activeUsers,
          timeRange,
        ),
        this.getManagedUserCountForBusiness(
          previousStartDate,
          previousEndDate,
          previousOverview.activeUsers,
          timeRange,
        ),
      ]);

      const business = this.buildBusinessFromStats(currentManagedUsers, currentBookings);
      const previousBusiness = this.buildBusinessFromStats(previousManagedUsers, previousBookings);
      const businessDelta = this.calculateBusinessDelta(business, previousBusiness);

      const formattedDailyTrend: DailyStats[] = dailyTrend.map((item) => ({
        date: item.date,
        messageCount: item.messageCount,
        successCount: item.successCount,
        avgDuration: item.avgDuration,
        tokenUsage: item.tokenUsage,
        uniqueUsers: item.uniqueUsers,
      }));

      const rawResponseTrend =
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

      const rawTokenTrend =
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
      const responseTrend = this.withResponseTrendFallback(
        rawResponseTrend,
        timeRange,
        currentEndDate,
        currentOverview,
      );
      const tokenTrend = this.withTokenTrendFallback(
        rawTokenTrend,
        timeRange,
        currentEndDate,
        currentOverview,
      );
      const businessTrend = this.withBusinessTrendFallback(
        rawBusinessTrend,
        timeRange,
        currentEndDate,
        business,
      );

      const response: DashboardOverviewResponse = {
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
        manualIntervention,
      };
      this.setCachedDashboardOverview(timeRange, normalizedGroups, response);
      return response;
    } catch (error) {
      this.logger.error('获取Dashboard概览数据失败:', error);
      throw error;
    }
  }

  private getCachedDashboardOverview(
    timeRange: TimeRange,
    groups: string[] = [],
  ): DashboardOverviewResponse | null {
    const cached = this.overviewCache.get(this.getOverviewCacheKey(timeRange, groups));
    if (!cached || cached.expireAt <= Date.now()) {
      this.overviewCache.delete(this.getOverviewCacheKey(timeRange, groups));
      return null;
    }
    return cached.value;
  }

  private setCachedDashboardOverview(
    timeRange: TimeRange,
    groups: string[],
    value: DashboardOverviewResponse,
  ): void {
    this.overviewCache.set(this.getOverviewCacheKey(timeRange, groups), {
      value,
      expireAt: Date.now() + this.getOverviewCacheTtlMs(timeRange),
    });
  }

  private getOverviewCacheKey(timeRange: TimeRange, groups: string[] = []): string {
    return groups.length > 0 ? `${timeRange}:${groups.join('|')}` : timeRange;
  }

  private async getDashboardOverviewByGroups(
    timeRange: TimeRange,
    groups: string[],
  ): Promise<DashboardOverviewResponse> {
    const cached = this.getCachedDashboardOverview(timeRange, groups);
    if (cached) {
      return cached;
    }

    const timeRanges = calculateDashboardTimeRanges(timeRange);
    const { currentStart, currentEnd, previousStart, previousEnd } = timeRanges;
    const currentStartDate = new Date(currentStart);
    const currentEndDate = new Date(currentEnd);
    const previousStartDate = new Date(previousStart);
    const previousEndDate = new Date(previousEnd);
    const activeUserWindowStart = new Date(Date.now() - this.ACTIVE_USER_WINDOW_MS);
    const activeUserWindowEnd = new Date();

    // 小组 chat_id 集合按 (start,end,groups) 各算一次即可复用：当前/对比/近1h 三窗口 + 托管用户数
    // 都从这三个集合派生，避免对 user_activity 重复分页扫描（此前 getGroupActiveUserCount 会再扫一遍）。
    const [currentChatIds, previousChatIds, activeUserChatIds] = await Promise.all([
      this.getGroupChatIds(currentStartDate, currentEndDate, groups),
      this.getGroupChatIds(previousStartDate, previousEndDate, groups),
      this.getGroupChatIds(activeUserWindowStart, activeUserWindowEnd, groups),
    ]);

    const [currentRecords, previousRecords, activeUserRecords] = await Promise.all([
      this.getGroupFilteredRecords(currentChatIds, currentStartDate, currentEndDate, timeRange),
      this.getGroupFilteredRecords(previousChatIds, previousStartDate, previousEndDate, timeRange),
      this.getGroupFilteredRecords(
        activeUserChatIds,
        activeUserWindowStart,
        activeUserWindowEnd,
        'today',
      ),
    ]);

    const currentOverview = this.calculateOverviewStatsFromRecords(
      currentRecords,
      this.countUniqueUsers(activeUserRecords),
    );
    const previousOverview = this.calculateOverviewStatsFromRecords(
      previousRecords,
      this.countUniqueUsers(previousRecords),
    );
    const currentFallback = this.calculateFallbackStats(currentRecords);
    const previousFallback = this.calculateFallbackStats(previousRecords);
    const manualIntervention = this.calculateManualInterventionStats(currentRecords);

    const rawBusinessTrend = this.analyticsTrendBuilder.buildBusinessTrend(
      currentRecords,
      timeRange,
    );
    const previousBusinessTrend = this.analyticsTrendBuilder.buildBusinessTrend(
      previousRecords,
      timeRange,
    );
    // 托管用户数 = 该窗口小组去重 chat_id 数，直接复用上面已算好的集合，不再二次扫描。
    const currentManagedUsers = currentChatIds.size;
    const previousManagedUsers = previousChatIds.size;

    const business = this.buildBusinessFromTrend(currentManagedUsers, rawBusinessTrend);
    const previousBusiness = this.buildBusinessFromTrend(
      previousManagedUsers,
      previousBusinessTrend,
    );

    const response: DashboardOverviewResponse = {
      timeRange,
      overview: currentOverview,
      overviewDelta: {
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
      },
      dailyTrend: this.buildDailyTrendFromRecords(currentRecords),
      tokenTrend: this.buildTokenTrendFromRecords(currentRecords, timeRange),
      businessTrend: rawBusinessTrend,
      responseTrend: this.analyticsTrendBuilder.buildResponseTrend(currentRecords, timeRange),
      business,
      businessDelta: this.calculateBusinessDelta(business, previousBusiness),
      fallback: currentFallback,
      fallbackDelta: this.calculateFallbackDelta(currentFallback, previousFallback),
      manualIntervention,
    };

    this.setCachedDashboardOverview(timeRange, groups, response);
    return response;
  }

  private normalizeGroups(groups: string[]): string[] {
    return Array.from(new Set(groups.map((group) => group.trim()).filter(Boolean))).sort();
  }

  private async getGroupFilteredRecords(
    allowedChatIds: Set<string>,
    startDate: Date,
    endDate: Date,
    timeRange: TimeRange,
  ): Promise<MessageProcessingRecord[]> {
    if (allowedChatIds.size === 0) {
      return [];
    }

    // 把小组的 chat_id 过滤下推到 DB：否则会先按 received_at desc 取最近 N 条（跨全部小组）
    // 再在内存过滤本小组，高流量窗口下本小组偏旧的记录会被 limit 截掉、指标被低估。
    // 下推后 limit 只约束本小组的记录。内存 filter 保留作兜底。
    const result = await this.messageProcessingService.getRecordsByTimestamps({
      startTime: startDate.getTime(),
      endTime: endDate.getTime(),
      chatIds: Array.from(allowedChatIds),
      limit: DETAIL_RECORD_LIMIT_BY_RANGE[timeRange] ?? DETAIL_RECORD_LIMIT_BY_RANGE.today,
    });

    return toMessageProcessingRecords(result.records).filter((record) =>
      allowedChatIds.has(record.chatId),
    );
  }

  private async getGroupChatIds(
    startDate: Date,
    endDate: Date,
    groups: string[],
  ): Promise<Set<string>> {
    // 把 group_name 过滤下推到 DB 并分页：避免「拉全量活跃列表再内存筛」在活跃用户超
    // PostgREST max_rows(默认 1000) 时被截断，导致本小组 chatIds / 活跃数 / 后续消息统计低估。
    return this.userHostingService.getActiveChatIdsByGroups(startDate, endDate, groups);
  }

  private calculateOverviewStatsFromRecords(
    records: MessageProcessingRecord[],
    activeUsers: number,
  ): DashboardOverviewStats & { activeUsers: number; activeChats: number } {
    const totalMessages = records.length;
    const successCount = records.filter((record) => record.status === 'success').length;
    const failureCount = totalMessages - successCount;
    const durations = records
      .filter((record) => record.totalDuration !== undefined)
      .map((record) => record.totalDuration ?? 0);
    const totalTokenUsage = records.reduce((sum, record) => sum + (record.tokenUsage ?? 0), 0);

    return {
      totalMessages,
      successCount,
      failureCount,
      successRate:
        totalMessages > 0 ? parseFloat(((successCount / totalMessages) * 100).toFixed(2)) : 0,
      avgDuration:
        durations.length > 0
          ? parseFloat(
              (durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(0),
            )
          : 0,
      activeUsers,
      activeChats: new Set(records.map((record) => record.chatId)).size,
      totalTokenUsage,
    };
  }

  private buildDailyTrendFromRecords(records: MessageProcessingRecord[]): DailyStats[] {
    const buckets = new Map<
      string,
      {
        messageCount: number;
        successCount: number;
        totalDuration: number;
        durationCount: number;
        tokenUsage: number;
        users: Set<string>;
      }
    >();

    for (const record of records) {
      const date = formatLocalDate(new Date(record.receivedAt));
      const bucket =
        buckets.get(date) ??
        ({
          messageCount: 0,
          successCount: 0,
          totalDuration: 0,
          durationCount: 0,
          tokenUsage: 0,
          users: new Set<string>(),
        } satisfies {
          messageCount: number;
          successCount: number;
          totalDuration: number;
          durationCount: number;
          tokenUsage: number;
          users: Set<string>;
        });

      bucket.messageCount += 1;
      if (record.status === 'success') bucket.successCount += 1;
      if (record.totalDuration !== undefined) {
        bucket.totalDuration += record.totalDuration;
        bucket.durationCount += 1;
      }
      bucket.tokenUsage += record.tokenUsage ?? 0;
      if (record.userId) bucket.users.add(record.userId);
      buckets.set(date, bucket);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, bucket]) => ({
        date,
        messageCount: bucket.messageCount,
        successCount: bucket.successCount,
        avgDuration:
          bucket.durationCount > 0 ? Math.round(bucket.totalDuration / bucket.durationCount) : 0,
        tokenUsage: bucket.tokenUsage,
        uniqueUsers: bucket.users.size,
      }));
  }

  private buildTokenTrendFromRecords(
    records: MessageProcessingRecord[],
    timeRange: TimeRange,
  ): { time: string; tokenUsage: number; messageCount: number }[] {
    const buckets = new Map<string, { tokenUsage: number; messageCount: number }>();

    for (const record of records) {
      const date = new Date(record.receivedAt);
      const key =
        timeRange === 'today' ? formatLocalMinute(getLocalHourStart(date)) : formatLocalDate(date);
      const bucket = buckets.get(key) ?? { tokenUsage: 0, messageCount: 0 };
      bucket.tokenUsage += record.tokenUsage ?? 0;
      bucket.messageCount += 1;
      buckets.set(key, bucket);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([time, bucket]) => ({ time, ...bucket }));
  }

  private buildBusinessFromTrend(
    activeUsers: number,
    trend: BusinessMetricTrendPoint[],
  ): BusinessMetricsSnapshot {
    const bookingAttempts = trend.reduce((sum, point) => sum + point.bookingAttempts, 0);
    const successfulBookings = trend.reduce((sum, point) => sum + point.successfulBookings, 0);

    return {
      consultations: { total: activeUsers, new: activeUsers },
      bookings: {
        attempts: bookingAttempts,
        successful: successfulBookings,
        failed: Math.max(0, bookingAttempts - successfulBookings),
        successRate:
          bookingAttempts > 0
            ? parseFloat(((successfulBookings / bookingAttempts) * 100).toFixed(2))
            : 0,
      },
      conversion: {
        consultationToBooking:
          activeUsers > 0 ? parseFloat(((successfulBookings / activeUsers) * 100).toFixed(2)) : 0,
      },
    };
  }

  private countUniqueUsers(records: MessageProcessingRecord[]): number {
    const ids = new Set<string>();
    for (const record of records) {
      ids.add(record.userId || record.chatId);
    }
    return ids.size;
  }

  private getOverviewCacheTtlMs(timeRange: TimeRange): number {
    return timeRange === 'today' ? 10_000 : 60_000;
  }

  private getHourStart(date: Date): Date {
    return getLocalHourStart(date);
  }

  private getDayStart(date: Date): Date {
    return getLocalDayStart(date);
  }

  private async recoverCurrentPeriodDailyTrend(
    currentStartDate: Date,
    currentEndDate: Date,
    timeRange: TimeRange,
  ): Promise<DailyTrendData[]> {
    this.logger.error(
      `[Dashboard] ${timeRange} 汇总有数据但日趋势为空，回源查询真实日趋势: start=${currentStartDate.toISOString()}, end=${currentEndDate.toISOString()}`,
    );

    try {
      const rawTrend = await this.monitoringRepository.getDashboardDailyTrend(
        currentStartDate,
        currentEndDate,
      );

      if (rawTrend.length === 0) {
        this.logger.error(
          `[Dashboard] ${timeRange} 回源日趋势仍为空，请检查 get_dashboard_daily_trend RPC 与 message_processing_records 时间字段`,
        );
      }

      return rawTrend;
    } catch (error) {
      this.logger.error(`[Dashboard] ${timeRange} 回源查询真实日趋势失败:`, error);
      return [];
    }
  }

  private getFallbackTrendTime(timeRange: TimeRange, currentEndDate: Date): string {
    return timeRange === 'today'
      ? formatLocalMinute(currentEndDate)
      : formatLocalDate(currentEndDate);
  }

  private withResponseTrendFallback(
    trend: ResponseMinuteTrendPoint[],
    timeRange: TimeRange,
    currentEndDate: Date,
    overview: DashboardOverviewStats,
  ): ResponseMinuteTrendPoint[] {
    if (trend.length > 0 || overview.totalMessages <= 0) {
      return trend;
    }

    this.logger.warn(
      `[Dashboard] ${timeRange} 响应趋势为空但汇总非 0，使用汇总点兜底避免前端空白，请继续排查趋势 RPC`,
    );

    return [
      {
        minute: this.getFallbackTrendTime(timeRange, currentEndDate),
        avgDuration: overview.avgDuration,
        messageCount: overview.totalMessages,
        successRate: overview.successRate,
      },
    ];
  }

  private withTokenTrendFallback(
    trend: { time: string; tokenUsage: number; messageCount: number }[],
    timeRange: TimeRange,
    currentEndDate: Date,
    overview: DashboardOverviewStats,
  ): { time: string; tokenUsage: number; messageCount: number }[] {
    if (trend.length > 0 || overview.totalMessages <= 0) {
      return trend;
    }

    this.logger.warn(
      `[Dashboard] ${timeRange} Token 趋势为空但汇总非 0，使用汇总点兜底避免前端空白，请继续排查趋势 RPC`,
    );

    return [
      {
        time: this.getFallbackTrendTime(timeRange, currentEndDate),
        tokenUsage: overview.totalTokenUsage,
        messageCount: overview.totalMessages,
      },
    ];
  }

  private withBusinessTrendFallback(
    trend: BusinessMetricTrendPoint[],
    timeRange: TimeRange,
    currentEndDate: Date,
    business: BusinessMetricsSnapshot,
  ): BusinessMetricTrendPoint[] {
    const consultations = business.consultations.total;
    if (trend.length > 0 || consultations <= 0) {
      return trend;
    }

    this.logger.warn(
      `[Dashboard] ${timeRange} 业务趋势为空但业务汇总非 0，使用汇总点兜底避免前端空白，请继续排查业务趋势 RPC`,
    );

    return [
      {
        minute: this.getFallbackTrendTime(timeRange, currentEndDate),
        consultations,
        bookingAttempts: business.bookings.attempts,
        successfulBookings: business.bookings.successful,
        conversionRate: business.conversion.consultationToBooking,
        bookingSuccessRate: business.bookings.successRate,
      },
    ];
  }

  private async isHourlyProjectionFresh(currentEndDate: Date): Promise<boolean> {
    try {
      const latestHourly = await this.hourlyStatsRepository.getLatestHourlyStat();

      if (!latestHourly?.hour) {
        return false;
      }

      const expectedLatestCompletedHour = new Date(
        this.getHourStart(currentEndDate).getTime() - 60 * 60 * 1000,
      );

      return new Date(latestHourly.hour).getTime() >= expectedLatestCompletedHour.getTime();
    } catch (error) {
      this.logger.warn('[Dashboard] 检查小时聚合新鲜度失败，回退到原始记录查询:', error);
      return false;
    }
  }

  private async isDailyProjectionFresh(currentEndDate: Date): Promise<boolean> {
    try {
      const latestDaily = await this.dailyStatsRepository.getLatestDailyStat();

      if (!latestDaily?.date) {
        return false;
      }

      const expectedLatestCompletedDay = addLocalDays(this.getDayStart(currentEndDate), -1);

      return latestDaily.date >= formatLocalDate(expectedLatestCompletedDay);
    } catch (error) {
      this.logger.warn('[Dashboard] 检查日聚合新鲜度失败，回退到原始记录查询:', error);
      return false;
    }
  }

  private async getDailyTrendFromProjectionRange(
    startDate: Date,
    endDate: Date,
  ): Promise<DailyTrendData[]> {
    const currentDayStart = this.getDayStart(endDate);

    if (endDate.getTime() <= currentDayStart.getTime()) {
      return this.dailyStatsAggregator.getDailyTrendFromDaily(startDate, endDate);
    }

    if (startDate.getTime() >= currentDayStart.getTime()) {
      return this.monitoringRepository.getDashboardDailyTrend(startDate, endDate);
    }

    const [historical, realtime] = await Promise.all([
      this.dailyStatsAggregator.getDailyTrendFromDaily(startDate, currentDayStart),
      this.monitoringRepository.getDashboardDailyTrend(currentDayStart, endDate),
    ]);

    return this.mergeDailyTrendData(historical, realtime);
  }

  private mergeDailyTrendData(
    historical: DailyTrendData[],
    realtime: DailyTrendData[],
  ): DailyTrendData[] {
    const byDate = new Map<string, DailyTrendData>();

    for (const row of [...historical, ...realtime]) {
      const existing = byDate.get(row.date);
      if (!existing) {
        byDate.set(row.date, { ...row });
        continue;
      }

      const messageCount = existing.messageCount + row.messageCount;
      const successCount = existing.successCount + row.successCount;
      const tokenUsage = existing.tokenUsage + row.tokenUsage;
      const avgDuration =
        successCount > 0
          ? Math.round(
              (existing.avgDuration * existing.successCount + row.avgDuration * row.successCount) /
                successCount,
            )
          : 0;

      byDate.set(row.date, {
        date: row.date,
        messageCount,
        successCount,
        avgDuration,
        tokenUsage,
        uniqueUsers: existing.uniqueUsers + row.uniqueUsers,
      });
    }

    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
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

  private async getRecentDetailRecords(limit: number = 50): Promise<MessageProcessingRecord[]> {
    try {
      const result = await this.messageProcessingService.getRecordsByTimestamps({ limit });
      return toMessageProcessingRecords(result.records);
    } catch (error) {
      this.logger.error('查询最近消息记录异常:', error);
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

  private async getBusinessTrendFromDatabase(
    startTime: number,
    endTime: number,
    activeUsers: number,
    range: TimeRange,
  ): Promise<BusinessMetricTrendPoint[]> {
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);

    if (range !== 'today') {
      const aggregateTrend = await this.getDailyBusinessTrendFromAggregates(startDate, endDate);
      if (aggregateTrend.length > 0 || activeUsers === 0) {
        return aggregateTrend;
      }

      this.logger.warn('[Dashboard] user_activity 业务趋势无结果，回退到原始记录聚合');
    }

    const businessTrend = await this.monitoringRepository.getDashboardBusinessTrend(
      startDate,
      endDate,
      5,
      range === 'today' ? 'minute' : 'day',
    );

    if (businessTrend.length > 0 || activeUsers === 0) {
      return businessTrend;
    }

    this.logger.warn('[Dashboard] 业务趋势聚合 RPC 无结果，回退到原始记录聚合');
    try {
      const result = await this.messageProcessingService.getBusinessTrendRecordsByTimeRange(
        startTime,
        endTime,
        DETAIL_RECORD_LIMIT_BY_RANGE[range] ?? DETAIL_RECORD_LIMIT_BY_RANGE.today,
      );
      return this.analyticsTrendBuilder.buildBusinessTrend(
        toMessageProcessingRecords(result),
        range,
      );
    } catch (error) {
      this.logger.error(`查询业务趋势记录异常 [${range}]:`, error);
      return [];
    }
  }

  private async getDailyBusinessTrendFromAggregates(
    startDate: Date,
    endDate: Date,
  ): Promise<BusinessMetricTrendPoint[]> {
    const [activityTrend, bookingStats] = await Promise.all([
      this.userHostingService.getDailyActivityStats(startDate, endDate),
      this.bookingService.getBookingStats({
        startDate: formatLocalDate(startDate),
        endDate: formatLocalDate(endDate),
      }),
    ]);

    const bookingCountByDate = new Map<string, number>();
    for (const item of bookingStats) {
      bookingCountByDate.set(
        item.date,
        (bookingCountByDate.get(item.date) ?? 0) + item.bookingCount,
      );
    }

    const dates = new Set<string>([
      ...activityTrend.map((item) => item.date),
      ...bookingStats.map((item) => item.date),
    ]);

    const activityByDate = new Map(activityTrend.map((item) => [item.date, item]));

    return Array.from(dates)
      .sort((a, b) => a.localeCompare(b))
      .map((date) => {
        const consultations = activityByDate.get(date)?.userCount ?? 0;
        const successfulBookings = bookingCountByDate.get(date) ?? 0;
        const bookingAttempts = successfulBookings;

        return {
          minute: date,
          consultations,
          bookingAttempts,
          successfulBookings,
          conversionRate:
            consultations > 0
              ? parseFloat(((successfulBookings / consultations) * 100).toFixed(2))
              : 0,
          bookingSuccessRate: bookingAttempts > 0 ? 100 : 0,
        };
      });
  }

  private async getManagedUserCountForBusiness(
    startDate: Date,
    endDate: Date,
    fallbackCount: number,
    range: TimeRange,
  ): Promise<number> {
    if (range === 'today') {
      return fallbackCount;
    }

    try {
      const userCount = await this.userHostingService.countActiveUsersByDateRange(
        startDate,
        endDate,
      );
      if (userCount > 0 || fallbackCount === 0) {
        return userCount;
      }
      return fallbackCount;
    } catch (error) {
      this.logger.warn('[Dashboard] 获取 user_activity 托管用户数失败，回退到概览统计:', error);
      return fallbackCount;
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
      const todayStart = getLocalDayStart();
      const dbUsers = await this.userHostingService.getActiveUsersByDateRange(
        todayStart,
        new Date(),
      );

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
    } catch (error) {
      this.logger.error('查询今日用户失败:', error);
      return [];
    }
  }

  // ========================================
  // 私有计算方法
  // ========================================

  private getTimeRangeCutoff(range: TimeRange): Date {
    return getDashboardTimeRangeCutoff(range);
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

  private calculateManualInterventionStats(
    records: MessageProcessingRecord[],
  ): DashboardManualInterventionStats {
    let handoffCount = 0;
    let riskAlertCount = 0;

    for (const record of records) {
      for (const call of record.toolCalls ?? []) {
        if (call.toolName === 'request_handoff') {
          handoffCount += 1;
        } else if (call.toolName === 'raise_risk_alert') {
          riskAlertCount += 1;
        }
      }
    }

    return {
      totalCount: handoffCount + riskAlertCount,
      handoffCount,
      riskAlertCount,
    };
  }

  /**
   * 人工介入触发统计（request_handoff + raise_risk_alert 工具调用次数）。
   *
   * 性能优化：历史已聚合小时从 monitoring_hourly_stats.tool_stats 汇总，当前未聚合的小时
   * 用实时查询补尾（窗口小、扫 records 很快），不再对整段范围扫 message_processing_records.tool_calls。
   * 小时聚合断更时回退到原始查询。
   *
   * 注意口径：这里仍是「工具调用次数」（含被 booking 守卫挡掉的 request_handoff）。
   * 「真实转人工次数」是 daily_ops_report.handoff_count（带守卫后才计），二者语义不同。
   */
  private async getManualInterventionStatsFromDatabase(
    startDate: Date,
    endDate: Date,
  ): Promise<DashboardManualInterventionStats> {
    try {
      const hourlyFresh = await this.isHourlyProjectionFresh(endDate);
      if (!hourlyFresh) {
        return this.getManualInterventionStatsFromRecords(startDate, endDate);
      }

      // 历史小时走聚合表，当前小时（tailStart..endDate）实时补。
      const hourStart = this.getHourStart(endDate);
      const tailStart = hourStart > startDate ? hourStart : startDate;

      const [hourlyRows, realtimeTail] = await Promise.all([
        this.hourlyStatsRepository.getHourlyStatsByDateRange(startDate, tailStart),
        this.monitoringRepository.getDashboardToolStats(tailStart, endDate),
      ]);

      let handoffCount = 0;
      let riskAlertCount = 0;
      for (const row of hourlyRows) {
        handoffCount += row.toolStats?.request_handoff ?? 0;
        riskAlertCount += row.toolStats?.raise_risk_alert ?? 0;
      }
      handoffCount +=
        realtimeTail.find((item) => item.toolName === 'request_handoff')?.useCount ?? 0;
      riskAlertCount +=
        realtimeTail.find((item) => item.toolName === 'raise_risk_alert')?.useCount ?? 0;

      return {
        totalCount: handoffCount + riskAlertCount,
        handoffCount,
        riskAlertCount,
      };
    } catch (error) {
      this.logger.warn('[Dashboard] 人工介入聚合查询失败，回退原始查询:', error);
      return this.getManualInterventionStatsFromRecords(startDate, endDate);
    }
  }

  /**
   * 概览核心统计。
   *
   * - 今日 / 日聚合断更 → 实时扫 message_processing_records（保证今日实时性 + 断更兜底）。
   * - 非今日 → 标量指标从 monitoring_daily_stats 汇总；活跃用户/会话用托管口径
   *   （user_activity 去重），不再对整段范围扫流水做 COUNT(DISTINCT)。
   *
   * 业务口径（运营确认）：非今日范围的「活跃用户 = 活跃会话 = 托管数」。
   * avg_duration 用 message_count 加权平均（聚合表无 duration_sum，加权是最优近似）。
   */
  private async getOverviewStatsForRange(
    startDate: Date,
    endDate: Date,
    isToday: boolean,
    dailyFresh: boolean,
  ): Promise<DashboardOverviewStats> {
    if (isToday || !dailyFresh) {
      return this.monitoringRepository.getDashboardOverviewStats(startDate, endDate);
    }

    try {
      const [rows, managedCount] = await Promise.all([
        this.dailyStatsRepository.getDailyStatsByDateRange(startDate, endDate),
        this.userHostingService.countActiveUsersByDateRange(startDate, endDate),
      ]);

      let totalMessages = 0;
      let successCount = 0;
      let failureCount = 0;
      let totalTokenUsage = 0;
      let durationWeighted = 0;
      for (const row of rows) {
        totalMessages += row.messageCount;
        successCount += row.successCount;
        failureCount += row.failureCount;
        totalTokenUsage += row.tokenUsage;
        durationWeighted += row.avgDuration * row.messageCount;
      }

      const successRate =
        totalMessages > 0 ? parseFloat(((successCount / totalMessages) * 100).toFixed(2)) : 0;
      const avgDuration = totalMessages > 0 ? Math.round(durationWeighted / totalMessages) : 0;

      return {
        totalMessages,
        successCount,
        failureCount,
        successRate,
        avgDuration,
        activeUsers: managedCount,
        activeChats: managedCount,
        totalTokenUsage,
      };
    } catch (error) {
      this.logger.warn('[Dashboard] 概览聚合查询失败，回退原始查询:', error);
      return this.monitoringRepository.getDashboardOverviewStats(startDate, endDate);
    }
  }

  /** 原始查询路径（聚合断更/异常时回退）：扫 message_processing_records.tool_calls。 */
  private async getManualInterventionStatsFromRecords(
    startDate: Date,
    endDate: Date,
  ): Promise<DashboardManualInterventionStats> {
    try {
      const toolStats = await this.monitoringRepository.getDashboardToolStats(startDate, endDate);
      const handoffCount =
        toolStats.find((item) => item.toolName === 'request_handoff')?.useCount ?? 0;
      const riskAlertCount =
        toolStats.find((item) => item.toolName === 'raise_risk_alert')?.useCount ?? 0;

      return {
        totalCount: handoffCount + riskAlertCount,
        handoffCount,
        riskAlertCount,
      };
    } catch (error) {
      this.logger.warn('[Dashboard] 获取人工介入触发统计失败，使用默认值 0:', error);
      return { ...EMPTY_MANUAL_INTERVENTION_STATS };
    }
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
    // interview_booking_records 只在预约接口返回 success 后写入，所以这里的统计即成功预约数。
    const conversionRate = activeUsers > 0 ? (bookingCount / activeUsers) * 100 : 0;
    const successRate = bookingCount > 0 ? 100 : 0;
    return {
      consultations: { total: activeUsers, new: activeUsers },
      bookings: {
        attempts: bookingCount,
        successful: bookingCount,
        failed: 0,
        successRate,
      },
      conversion: { consultationToBooking: parseFloat(conversionRate.toFixed(2)) },
    };
  }

  /**
   * 轻量查询：获取指定日期范围的预约总数
   */
  /**
   * 预约成功数。
   *
   * 优先使用 daily_ops_report.booking_success_count（与转化分析页同源）。
   * 当运营投影只覆盖查询区间后半段时，用 interview_booking_records 填补投影最早日期
   * 之前的缺口，避免整个区间回退旧源导致新投影数据失效。
   */
  private async getBookingCount(startDate: string, endDate: string): Promise<number> {
    try {
      const opsBooking = await this.getOpsBookingCountWithLegacyGap(startDate, endDate);
      if (opsBooking !== null) {
        return opsBooking;
      }
      return this.getLegacyBookingCount(startDate, endDate);
    } catch (error) {
      this.logger.warn('[业务指标] 获取预约统计失败，使用默认值 0:', error);
      return 0;
    }
  }

  /**
   * 若 daily_ops_report 与查询范围有交集，则返回「旧源缺口 + 投影覆盖段」的预约成功数。
   * 若投影表不可用或完全晚于查询范围，则返回 null（上层回退旧源全量范围）。
   */
  private async getOpsBookingCountWithLegacyGap(
    startDate: string,
    endDate: string,
  ): Promise<number | null> {
    try {
      const earliest = await this.dailyOpsReportRepository.getEarliestReportDate();
      if (!earliest || earliest > endDate) {
        return null;
      }

      const opsStartDate = earliest > startDate ? earliest : startDate;
      const [opsSums, legacyGapCount] = await Promise.all([
        this.dailyOpsReportRepository.sumByDateRange(opsStartDate, endDate),
        earliest > startDate
          ? this.getLegacyBookingCount(startDate, this.getPreviousLocalDate(earliest))
          : Promise.resolve(0),
      ]);

      return legacyGapCount + opsSums.bookingSuccess;
    } catch (error) {
      this.logger.warn('[业务指标] daily_ops_report 预约汇总失败，回退旧源全量范围:', error);
      return null;
    }
  }

  private async getLegacyBookingCount(startDate: string, endDate: string): Promise<number> {
    const bookingStats = await this.bookingService.getBookingStats({ startDate, endDate });
    return bookingStats.reduce((sum, item) => sum + item.bookingCount, 0);
  }

  private getPreviousLocalDate(date: string): string {
    return formatLocalDate(addLocalDays(parseLocalDateStart(date), -1));
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
    const hours = TREND_HOURS_BY_RANGE[timeRange] ?? TREND_HOURS_BY_RANGE.month;
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

  buildBusinessTrend(
    records: MessageProcessingRecord[],
    timeRange: TimeRange,
  ): BusinessMetricTrendPoint[] {
    return this.analyticsTrendBuilder.buildBusinessTrend(records, timeRange);
  }

  private buildToolUsageMetrics(records: MessageProcessingRecord[]): ToolUsageMetric[] {
    const toolMap = new Map<string, number>();
    for (const record of records) {
      if (!record.toolCalls || record.toolCalls.length === 0) continue;
      for (const call of record.toolCalls) {
        if (!call.toolName) continue;
        toolMap.set(call.toolName, (toolMap.get(call.toolName) || 0) + 1);
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
    return formatLocalMinute(new Date(timestamp));
  }

  private getDayKey(timestamp: number): string {
    return formatLocalDate(new Date(timestamp));
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
      manualIntervention: { ...EMPTY_MANUAL_INTERVENTION_STATS },
      business: {
        consultations: { total: 0, new: 0 },
        bookings: { attempts: 0, successful: 0, failed: 0, successRate: 0 },
        conversion: { consultationToBooking: 0 },
      },
      businessDelta: { consultations: 0, bookingAttempts: 0, bookingSuccessRate: 0 },
      usage: { tools: [], scenarios: [] },
      queue: { activeRequests: 0, peakActiveRequests: 0, queueWaitingJobs: 0, avgQueueDuration: 0 },
      alertsSummary: { total: 0, lastHour: 0, last24Hours: 0, byType: [] },
      trends: { hourly: [] },
      responseTrend: [],
      alertTrend: [],
      businessTrend: [],
      todayUsers: [],
      recentMessages: [],
      recentErrors: [],
      realtime: { activeRequests: 0 },
    };
  }
}

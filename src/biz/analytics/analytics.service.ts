import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  MessageProcessingRecord,
  HourlyStats,
  DashboardData,
  MetricsData,
  ScenarioUsageMetric,
  ToolUsageMetric,
  MonitoringErrorLog,
  MonitoringGlobalCounters,
  ResponseMinuteTrendPoint,
  AlertTrendPoint,
  AlertTypeMetric,
  TimeRange,
  DailyStats,
  TodayUser,
  AlertErrorType,
  BusinessMetricTrendPoint,
} from '@/core/monitoring/interfaces/monitoring.interface';
import { MonitoringCacheService } from '@/core/monitoring/monitoring-cache.service';
import { RedisService } from '@core/redis';
import { FeishuBookingService } from '@/core/feishu/services/feishu-booking.service';
import { MessageProcessingRepository, BookingRepository } from '@db/message';
import {
  MonitoringHourlyStatsRepository,
  MonitoringErrorLogRepository,
  MonitoringRepository,
  DashboardOverviewStats,
  DashboardFallbackStats,
  DailyTrendData,
} from '@db/monitoring';
import { UserHostingRepository } from '@db/user';
import { UserHostingService } from '@biz/user/user-hosting.service';
import { HourlyStatsAggregatorService } from './services/hourly-stats-aggregator.service';
import { MessageTrackingService } from '@/core/monitoring/services/message-tracking.service';
import { AgentRegistryService } from '@/agent/services/agent-registry.service';
import * as os from 'os';

/**
 * Analytics 业务分析服务
 * 负责 Dashboard 数据聚合、趋势计算、用户统计
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly DEFAULT_WINDOW_HOURS = 24;

  constructor(
    private readonly messageProcessingRepository: MessageProcessingRepository,
    private readonly hourlyStatsRepository: MonitoringHourlyStatsRepository,
    private readonly errorLogRepository: MonitoringErrorLogRepository,
    private readonly userHostingRepository: UserHostingRepository,
    private readonly userHostingService: UserHostingService,
    private readonly cacheService: MonitoringCacheService,
    private readonly redisService: RedisService,
    private readonly feishuBookingService: FeishuBookingService,
    private readonly monitoringRepository: MonitoringRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly hourlyStatsAggregator: HourlyStatsAggregatorService,
    private readonly messageTrackingService: MessageTrackingService,
    private readonly agentRegistryService: AgentRegistryService,
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

      const [
        currentRecords,
        previousRecords,
        recentMessages,
        errorLogs,
        todayUsers,
        globalCounters,
      ] = await Promise.all([
        this.getRecordsByTimeRange(currentStart, currentEnd),
        this.getRecordsByTimeRange(previousStart, previousEnd),
        this.getRecentDetailRecords(50),
        this.getErrorLogsByTimeRange(timeRange),
        timeRange === 'today' ? this.getTodayUsersFromDatabase() : Promise.resolve([]),
        this.cacheService.getCounters(),
      ]);

      const overview = this.calculateOverview(currentRecords);
      const previousOverview = this.calculateOverview(previousRecords);
      const overviewDelta = this.calculateOverviewDelta(overview, previousOverview);

      const fallback = this.calculateFallbackStats(currentRecords);
      const previousFallback = this.calculateFallbackStats(previousRecords);
      const fallbackDelta = this.calculateFallbackDelta(fallback, previousFallback);

      const currentStartDate = new Date(currentStart).toISOString().split('T')[0];
      const currentEndDate = new Date(currentEnd).toISOString().split('T')[0];
      const previousStartDate = new Date(previousStart).toISOString().split('T')[0];
      const previousEndDate = new Date(previousEnd).toISOString().split('T')[0];

      const [business, previousBusiness] = await Promise.all([
        this.getBusinessMetricsFromDatabase(currentStartDate, currentEndDate, currentRecords),
        this.getBusinessMetricsFromDatabase(previousStartDate, previousEndDate, previousRecords),
      ]);
      const businessDelta = this.calculateBusinessDelta(business, previousBusiness);

      const usage = {
        tools: this.buildToolUsageMetrics(currentRecords),
        scenarios: this.buildScenarioUsageMetrics(currentRecords),
      };

      const queue = this.calculateQueueMetrics(currentRecords, globalCounters);
      const alertsSummary = this.calculateAlertsSummary(errorLogs);
      const trends = await this.calculateTrends(timeRange);
      const responseTrend = this.buildResponseTrend(currentRecords, timeRange);
      const alertTrend = this.buildAlertTrend(errorLogs, timeRange);
      const businessTrend = this.buildBusinessTrend(currentRecords, timeRange);

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
    business: ReturnType<AnalyticsService['calculateBusinessMetrics']>;
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

      let currentOverview: DashboardOverviewStats;
      let previousOverview: DashboardOverviewStats;
      let currentFallback: DashboardFallbackStats;
      let previousFallback: DashboardFallbackStats;
      let dailyTrend: DailyTrendData[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let minuteTrend: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let tokenTrendData: any[];

      if (timeRange === 'today') {
        const currentHourStart = new Date();
        currentHourStart.setMinutes(0, 0, 0);

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
          this.hourlyStatsAggregator.getDailyTrendFromHourly(sevenDaysAgo, new Date()),
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
            this.hourlyStatsAggregator.getDailyTrendFromHourly(sevenDaysAgo, new Date()),
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

      const businessRecords = await this.getDetailRecordsByTimeRange(timeRange);
      const business = this.calculateBusinessMetrics(businessRecords);
      const previousBusiness = {
        consultations: { total: 0, new: 0 },
        bookings: { attempts: 0, successful: 0, failed: 0, successRate: 0 },
        conversion: { consultationToBooking: 0 },
      };
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

      const businessTrend = this.buildBusinessTrend(businessRecords, timeRange);

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
    const CACHE_KEY = 'monitoring:today_users';
    const CACHE_TTL_SEC = 30;

    try {
      const cached = await this.redisService.get<string>(CACHE_KEY);
      if (cached) {
        const parsedData = JSON.parse(cached) as TodayUser[];
        this.logger.debug(`[Redis] 命中今日用户缓存 (${parsedData.length} 条记录)`);
        return parsedData;
      }
    } catch (error) {
      this.logger.warn('[Redis] 获取今日用户缓存失败，降级到数据库查询', error);
    }

    const users = await this.getTodayUsersFromDatabase();

    if (users.length > 0) {
      try {
        await this.redisService.setex(CACHE_KEY, CACHE_TTL_SEC, JSON.stringify(users));
      } catch (error) {
        this.logger.warn('[Redis] 写入今日用户缓存失败', error);
      }
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

  /**
   * 清空所有监控统计数据（数据库记录）
   */
  async clearAllDataAsync(): Promise<void> {
    try {
      this.logger.warn('执行大规模数据清理: Monitoring stats & Message processing records');
      await Promise.all([
        this.messageProcessingRepository.clearAllRecords(),
        this.hourlyStatsRepository.clearAllRecords(),
        this.errorLogRepository.clearAllRecords(),
      ]);
      await this.cacheService.resetCounters();
    } catch (error) {
      this.logger.error('清空监控数据失败:', error);
      throw error;
    }
  }

  /**
   * 清除指定类型的缓存
   */
  async clearCacheAsync(type: 'all' | 'metrics' | 'history' | 'agent' = 'all'): Promise<void> {
    try {
      this.logger.log(`执行清除缓存任务: ${type}`);
      if (type === 'all' || type === 'metrics') {
        await this.cacheService.resetCounters();
      }

      if (type === 'all' || type === 'history') {
        await this.cacheService.clearAll();
      }

      if (type === 'all' || type === 'agent') {
        await this.agentRegistryService.refresh();
      }
    } catch (error) {
      this.logger.error(`清除缓存失败 [${type}]:`, error);
      throw error;
    }
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

  // ========================================
  // 定时聚合任务
  // ========================================

  /**
   * 小时统计聚合定时任务
   * 每小时第 5 分钟执行
   */
  @Cron('5 * * * *', {
    name: 'aggregateHourlyStats',
    timeZone: 'Asia/Shanghai',
  })
  async aggregateHourlyStats(): Promise<void> {
    try {
      const startTime = Date.now();
      this.logger.log('开始执行小时统计聚合任务...');

      const now = new Date();
      const lastHourEnd = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        now.getHours(),
        0,
        0,
        0,
      );
      const lastHourStart = new Date(lastHourEnd.getTime() - 60 * 60 * 1000);
      const hourKey = lastHourStart.toISOString();

      this.logger.log(
        `聚合时间范围: ${lastHourStart.toISOString()} ~ ${lastHourEnd.toISOString()}`,
      );

      const aggregated = await this.monitoringRepository.aggregateHourlyStats(
        lastHourStart,
        lastHourEnd,
      );

      if (!aggregated || aggregated.messageCount === 0) {
        this.logger.warn(`该小时无数据记录,跳过聚合: ${hourKey}`);
        return;
      }

      const hourlyStats: HourlyStats = {
        hour: hourKey,
        messageCount: aggregated.messageCount,
        successCount: aggregated.successCount,
        failureCount: aggregated.failureCount,
        successRate: aggregated.successRate,
        avgDuration: aggregated.avgDuration,
        minDuration: aggregated.minDuration,
        maxDuration: aggregated.maxDuration,
        p50Duration: aggregated.p50Duration,
        p95Duration: aggregated.p95Duration,
        p99Duration: aggregated.p99Duration,
        avgAiDuration: aggregated.avgAiDuration,
        avgSendDuration: aggregated.avgSendDuration,
        activeUsers: aggregated.activeUsers,
        activeChats: aggregated.activeChats,
        totalTokenUsage: aggregated.totalTokenUsage,
        fallbackCount: aggregated.fallbackCount,
        fallbackSuccessCount: aggregated.fallbackSuccessCount,
        scenarioStats: aggregated.scenarioStats,
        toolStats: aggregated.toolStats,
      };

      await this.hourlyStatsRepository.saveHourlyStats(hourlyStats);

      const elapsed = Date.now() - startTime;
      this.logger.log(
        `小时统计聚合完成: ${hourKey}, ` +
          `消息数=${aggregated.messageCount}, 成功率=${aggregated.successRate}%, ` +
          `活跃用户=${aggregated.activeUsers}, 活跃会话=${aggregated.activeChats}, ` +
          `Token=${aggregated.totalTokenUsage}, 耗时=${elapsed}ms`,
      );
    } catch (error) {
      this.logger.error('小时统计聚合任务失败:', error);
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

  public async getRecentDetailRecords(limit: number = 50): Promise<MessageProcessingRecord[]> {
    try {
      const result = await this.messageProcessingRepository.getMessageProcessingRecords({ limit });
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
      const bookingStats = await this.bookingRepository.getBookingStats({ startDate, endDate });
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

  private calculateBusinessMetrics(records: MessageProcessingRecord[]) {
    const users = new Set(records.filter((r) => r.userId).map((r) => r.userId!));
    return {
      consultations: { total: users.size, new: users.size },
      bookings: { attempts: 0, successful: 0, failed: 0, successRate: 0 },
      conversion: { consultationToBooking: 0 },
    };
  }

  private calculateBusinessDelta(
    current: ReturnType<typeof this.calculateBusinessMetrics>,
    previous: ReturnType<typeof this.calculateBusinessMetrics>,
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

  private calculatePercentChange(current: number, previous: number): number {
    if (previous === 0) return current === 0 ? 0 : 100;
    return parseFloat((((current - previous) / previous) * 100).toFixed(2));
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

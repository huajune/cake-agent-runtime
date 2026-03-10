import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  MessageProcessingRecord,
  HourlyStats,
  DashboardData,
  MetricsData,
  MonitoringMetadata,
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
} from './interfaces/monitoring.interface';
import { MonitoringDatabaseService } from './monitoring-database.service';
import { MonitoringCacheService } from './monitoring-cache.service';
import { MonitoringMigrationService } from './monitoring-migration.service';
import { RedisService } from '@core/redis';
import { FeishuBookingService } from '@/core/feishu/services/feishu-booking.service';
import {
  MonitoringRepository,
  BookingRepository,
  DashboardOverviewStats,
  DashboardFallbackStats,
  DailyTrendData,
} from '@core/supabase/repositories';
import { HourlyStatsAggregatorService } from './hourly-stats-aggregator.service';

/**
 * 监控服务
 * 负责收集、存储和统计消息处理数据
 */
@Injectable()
export class MonitoringService implements OnModuleInit {
  private readonly logger = new Logger(MonitoringService.name);
  private readonly DEFAULT_WINDOW_HOURS = 24;

  // 临时记录存储（仅保留未完成的消息，完成后写入数据库）
  private pendingRecords = new Map<string, MessageProcessingRecord>();

  // 定期清理超过 1 小时的临时记录（防止内存泄漏）
  private readonly PENDING_RECORD_TTL_MS = 60 * 60 * 1000; // 1 小时

  constructor(
    private readonly databaseService: MonitoringDatabaseService,
    private readonly cacheService: MonitoringCacheService,
    private readonly migrationService: MonitoringMigrationService,
    private readonly redisService: RedisService,
    private readonly feishuBookingService: FeishuBookingService,
    private readonly monitoringRepository: MonitoringRepository,
    private readonly bookingRepository: BookingRepository,
    private readonly hourlyStatsAggregator: HourlyStatsAggregatorService,
  ) {
    // 定期清理超时的临时记录（每10分钟执行一次）
    setInterval(
      () => {
        this.cleanupPendingRecords();
      },
      10 * 60 * 1000,
    );

    this.logger.log('监控服务已启动（Supabase + Redis 架构）');
  }

  async onModuleInit(): Promise<void> {
    // 执行数据迁移（仅首次启动时）
    try {
      const result = await this.migrationService.migrateSnapshotToNewArchitecture();
      if (result.success && result.recordsMigrated > 0) {
        this.logger.log(
          `数据迁移成功: 记录=${result.recordsMigrated}, 小时统计=${result.hourlyStatsMigrated}, 错误日志=${result.errorLogsMigrated}`,
        );
      }
    } catch (error) {
      this.logger.error('数据迁移失败，将继续启动服务:', error);
    }
  }

  /**
   * 记录消息接收
   */
  recordMessageReceived(
    messageId: string,
    chatId: string,
    userId?: string,
    userName?: string,
    messageContent?: string,
    metadata?: MonitoringMetadata,
    managerName?: string,
  ): void {
    const now = Date.now();
    const record: MessageProcessingRecord = {
      messageId,
      chatId,
      userId,
      userName,
      managerName,
      receivedAt: now,
      status: 'processing',
      messagePreview: messageContent ? messageContent.substring(0, 50) : undefined,
      scenario: metadata?.scenario,
    };

    // 存入临时记录
    this.pendingRecords.set(messageId, record);
    this.logger.debug(
      `[recordMessageReceived] 已创建临时记录 [${messageId}], pendingRecords size=${this.pendingRecords.size}`,
    );

    // 💾 立即保存 processing 状态到数据库（用户可见处理中的消息）
    this.saveRecordToDatabase(record).catch((err) => {
      this.logger.warn(`保存 processing 状态到数据库失败 (messageId: ${messageId}):`, err);
    });

    // 更新 Redis 缓存
    this.cacheService.incrementCounter('totalMessages', 1).catch((err) => {
      this.logger.warn('更新 totalMessages 计数器失败:', err);
    });

    // 记录活跃用户和会话
    if (userId) {
      this.cacheService.addActiveUser(userId, now).catch((err) => {
        this.logger.warn('记录活跃用户失败:', err);
      });
    }
    if (chatId) {
      this.cacheService.addActiveChat(chatId, now).catch((err) => {
        this.logger.warn('记录活跃会话失败:', err);
      });
    }

    // 更新并发统计
    this.cacheService.incrementCurrentProcessing(1).then((newValue) => {
      this.cacheService.updatePeakProcessing(newValue).catch((err) => {
        this.logger.warn('更新峰值处理数失败:', err);
      });
    });

    // 💾 立即写入 user_activity 表（消息接收时就记录，不等处理完成）
    // 这样可以确保即使消息处理失败或卡住，用户活动也会被记录
    this.databaseService
      .saveUserActivity({
        chatId,
        userId,
        userName,
        messageCount: 1,
        tokenUsage: 0, // 接收时 token 还未消耗，后续 recordSuccess 会更新
        activeAt: now,
      })
      .catch((err) => {
        this.logger.warn(`记录用户活动失败 [${messageId}]:`, err);
      });

    this.logger.log(
      `[Monitoring] 记录消息接收 [${messageId}], chatId=${chatId}, scenario=${metadata?.scenario ?? 'unknown'}`,
    );
  }

  /**
   * 记录 Worker 开始处理（用于计算真正的队列等待时间）
   * 应在 Bull Worker 回调函数入口处调用
   */
  recordWorkerStart(messageId: string): void {
    const record = this.pendingRecords.get(messageId);
    if (record) {
      const now = Date.now();
      // queueDuration = Worker 开始处理时间 - 消息接收时间
      // 这个时间包含：消息聚合等待 + Bull Queue 等待
      record.queueDuration = now - record.receivedAt;
      this.logger.debug(`记录 Worker 开始处理 [${messageId}], queue=${record.queueDuration}ms`);
    }
  }

  /**
   * 记录 AI 处理开始
   * 应在调用 Agent API 之前调用
   */
  recordAiStart(messageId: string): void {
    const record = this.pendingRecords.get(messageId);
    if (record) {
      const now = Date.now();
      record.aiStartAt = now;

      // 如果已经记录了 queueDuration（Worker 开始时间），计算预处理耗时
      if (record.queueDuration !== undefined) {
        // prepDuration = AI 开始时间 - Worker 开始时间
        // Worker 开始时间 = receivedAt + queueDuration
        const workerStartAt = record.receivedAt + record.queueDuration;
        record.prepDuration = now - workerStartAt;
        this.logger.debug(`记录 AI 开始处理 [${messageId}], prep=${record.prepDuration}ms`);
      } else {
        // 兼容旧逻辑：如果没有调用 recordWorkerStart，直接计算 queueDuration
        record.queueDuration = now - record.receivedAt;
        this.logger.debug(
          `记录 AI 开始处理 [${messageId}], queue=${record.queueDuration}ms (legacy)`,
        );
      }
    }
  }

  /**
   * 记录 AI 处理完成
   */
  recordAiEnd(messageId: string): void {
    const record = this.pendingRecords.get(messageId);
    if (record && record.aiStartAt) {
      record.aiEndAt = Date.now();
      record.aiDuration = record.aiEndAt - record.aiStartAt;

      // 更新 Redis 计数器
      this.cacheService.incrementCounter('totalAiDuration', record.aiDuration).catch((err) => {
        this.logger.warn('更新 totalAiDuration 计数器失败:', err);
      });

      this.logger.debug(`记录 AI 完成处理 [${messageId}], 耗时: ${record.aiDuration}ms`);
    }
  }

  /**
   * 记录消息发送开始
   */
  recordSendStart(messageId: string): void {
    const record = this.pendingRecords.get(messageId);
    if (record) {
      record.sendStartAt = Date.now();
      this.logger.debug(`记录消息发送开始 [${messageId}]`);
    }
  }

  /**
   * 记录消息发送完成
   */
  recordSendEnd(messageId: string): void {
    const record = this.pendingRecords.get(messageId);
    if (record && record.sendStartAt) {
      record.sendEndAt = Date.now();
      record.sendDuration = record.sendEndAt - record.sendStartAt;

      // 更新 Redis 计数器
      this.cacheService.incrementCounter('totalSendDuration', record.sendDuration).catch((err) => {
        this.logger.warn('更新 totalSendDuration 计数器失败:', err);
      });

      this.logger.debug(`记录消息发送完成 [${messageId}], 耗时: ${record.sendDuration}ms`);
    }
  }

  /**
   * 记录消息处理成功
   */
  recordSuccess(
    messageId: string,
    metadata?: MonitoringMetadata & { fallbackSuccess?: boolean },
  ): void {
    this.logger.debug(
      `[recordSuccess] 开始处理 [${messageId}], pendingRecords size=${this.pendingRecords.size}`,
    );

    const record = this.pendingRecords.get(messageId);

    if (!record) {
      this.logger.error(
        `[recordSuccess] ❌ 临时记录未找到 [${messageId}]，无法更新状态为 success。` +
          ` 当前 pendingRecords 包含: [${Array.from(this.pendingRecords.keys()).join(', ')}]`,
      );
      return;
    }

    // 更新记录状态
    record.status = 'success';
    record.totalDuration = Date.now() - record.receivedAt;
    record.scenario = metadata?.scenario || record.scenario;
    record.tools = metadata?.tools || record.tools;
    record.tokenUsage = metadata?.tokenUsage ?? record.tokenUsage;
    record.replyPreview = metadata?.replyPreview ?? record.replyPreview;
    record.replySegments = metadata?.replySegments ?? record.replySegments;
    record.isFallback = metadata?.isFallback ?? record.isFallback;
    record.fallbackSuccess = metadata?.fallbackSuccess ?? record.fallbackSuccess;
    record.agentInvocation = metadata?.agentInvocation ?? record.agentInvocation;
    record.batchId = metadata?.batchId ?? record.batchId;
    record.isPrimary = metadata?.isPrimary ?? record.isPrimary;

    // 更新 Redis 计数器
    const counterUpdates: Partial<MonitoringGlobalCounters> = { totalSuccess: 1 };
    if (record.isFallback) {
      counterUpdates.totalFallback = 1;
      if (record.fallbackSuccess) {
        counterUpdates.totalFallbackSuccess = 1;
      }
    }

    this.cacheService.incrementCounters(counterUpdates).catch((err) => {
      this.logger.warn('更新成功计数器失败:', err);
    });

    // 减少当前处理数
    this.cacheService.incrementCurrentProcessing(-1).catch((err) => {
      this.logger.warn('减少当前处理数失败:', err);
    });

    this.logger.log(
      `消息处理成功 [${messageId}], 总耗时: ${record.totalDuration}ms, scenario=${
        record.scenario || 'unknown'
      }, fallback=${record.isFallback ? 'true' : 'false'}`,
    );

    // 异步写入数据库（不阻塞主流程）
    this.saveRecordToDatabase(record)
      .catch((err) => {
        this.logger.error(`保存消息处理记录到数据库失败 [${messageId}]:`, err);
      })
      .finally(() => {
        // 从临时记录中删除
        this.logger.debug(
          `[recordSuccess] 准备删除临时记录 [${messageId}], pendingRecords size=${this.pendingRecords.size}`,
        );
        this.pendingRecords.delete(messageId);
        this.logger.debug(
          `[recordSuccess] 已删除临时记录 [${messageId}], pendingRecords size=${this.pendingRecords.size}`,
        );
      });

    // 更新 user_activity 的 tokenUsage（messageCount 已在 recordMessageReceived 时写入）
    // 只有当有 token 消耗时才需要更新
    if (record.tokenUsage && record.tokenUsage > 0) {
      this.databaseService
        .saveUserActivity({
          chatId: record.chatId,
          userId: record.userId,
          userName: record.userName,
          messageCount: 0, // 不再增加消息数，已在 recordMessageReceived 时计数
          tokenUsage: record.tokenUsage,
          activeAt: record.receivedAt,
        })
        .catch((err) => {
          this.logger.warn(`更新用户 Token 消耗失败 [${messageId}]:`, err);
        });
    }
  }

  /**
   * 记录消息处理失败
   */
  recordFailure(
    messageId: string,
    error: string,
    metadata?: MonitoringMetadata & { fallbackSuccess?: boolean },
  ): void {
    this.logger.debug(`[recordFailure] 开始处理 [${messageId}]`);

    const record = this.pendingRecords.get(messageId);

    if (!record) {
      this.logger.error(
        `[recordFailure] ❌ 临时记录未找到 [${messageId}]，无法更新状态为 failure。`,
      );
      // 即使记录不存在，也要记录错误日志（使用 metadata 中的错误类型）
      this.saveErrorLog(messageId, error, metadata?.alertType);
      return;
    }

    // 更新记录状态
    record.status = 'failure';
    record.error = error;
    record.totalDuration = Date.now() - record.receivedAt;
    record.scenario = metadata?.scenario || record.scenario;
    record.tools = metadata?.tools || record.tools;
    record.tokenUsage = metadata?.tokenUsage ?? record.tokenUsage;
    record.replySegments = metadata?.replySegments ?? record.replySegments;
    record.isFallback = metadata?.isFallback ?? record.isFallback;
    record.fallbackSuccess = metadata?.fallbackSuccess ?? record.fallbackSuccess;
    record.alertType = metadata?.alertType ?? record.alertType;

    // 更新 Redis 计数器
    const counterUpdates: Partial<MonitoringGlobalCounters> = { totalFailure: 1 };
    if (record.isFallback) {
      counterUpdates.totalFallback = 1;
      if (record.fallbackSuccess) {
        counterUpdates.totalFallbackSuccess = 1;
      }
    }

    this.cacheService.incrementCounters(counterUpdates).catch((err) => {
      this.logger.warn('更新失败计数器失败:', err);
    });

    // 减少当前处理数
    this.cacheService.incrementCurrentProcessing(-1).catch((err) => {
      this.logger.warn('减少当前处理数失败:', err);
    });

    // 添加到错误日志（包含错误类型）
    this.saveErrorLog(messageId, error, record.alertType);

    this.logger.error(
      `消息处理失败 [${messageId}]: ${error}, scenario=${record.scenario || 'unknown'}, alertType=${record.alertType || 'unknown'}, fallback=${record.isFallback ? 'true' : 'false'}`,
    );

    // 异步写入数据库（不阻塞主流程）
    this.saveRecordToDatabase(record)
      .catch((err) => {
        this.logger.error(`保存失败消息处理记录到数据库失败 [${messageId}]:`, err);
      })
      .finally(() => {
        // 从临时记录中删除
        this.pendingRecords.delete(messageId);
      });
  }

  async getTodayUsers(): Promise<TodayUser[]> {
    const CACHE_KEY = 'monitoring:today_users';
    const CACHE_TTL_SEC = 30; // 30秒缓存

    // 1. 尝试从 Redis 获取缓存
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

    // 2. 从数据库查询
    const users = await this.getTodayUsersFromDatabase();

    // 3. 写入 Redis 缓存
    if (users.length > 0) {
      try {
        await this.redisService.setex(CACHE_KEY, CACHE_TTL_SEC, JSON.stringify(users));
        this.logger.debug(
          `[Redis] 已缓存今日用户数据 (${users.length} 条记录, TTL: ${CACHE_TTL_SEC}s)`,
        );
      } catch (error) {
        this.logger.warn('[Redis] 写入今日用户缓存失败', error);
      }
    }

    return users;
  }

  /**
   * 获取仪表盘数据（从 Supabase + Redis 读取真实数据）
   * @param timeRange 时间范围：today/week/month
   */
  async getDashboardDataAsync(timeRange: TimeRange = 'today'): Promise<DashboardData> {
    try {
      // 1. 计算时间范围
      const timeRanges = this.calculateTimeRanges(timeRange);
      const { currentStart, currentEnd, previousStart, previousEnd } = timeRanges;

      // 2. 并行查询所有需要的数据
      const [
        currentRecords,
        previousRecords,
        recentMessages,
        errorLogs,
        todayUsers,
        globalCounters,
      ] = await Promise.all([
        // 当前时间范围的消息记录
        this.databaseService.getRecordsByTimeRange(currentStart, currentEnd),
        // 前一时间范围的消息记录（用于计算增长率）
        this.databaseService.getRecordsByTimeRange(previousStart, previousEnd),
        // 最近 50 条消息
        this.databaseService.getRecentDetailRecords(50),
        // 当前时间范围的错误日志
        this.databaseService.getErrorLogsByTimeRange(timeRange),
        // 今日用户（仅 today 范围）
        timeRange === 'today' ? this.getTodayUsersFromDatabase() : Promise.resolve([]),
        // Redis 全局计数器
        this.cacheService.getCounters(),
      ]);

      // 3. 计算基础指标
      const overview = this.calculateOverview(currentRecords);
      const previousOverview = this.calculateOverview(previousRecords);
      const overviewDelta = this.calculateOverviewDelta(overview, previousOverview);

      // 4. 计算降级统计
      const fallback = this.calculateFallbackStats(currentRecords);
      const previousFallback = this.calculateFallbackStats(previousRecords);
      const fallbackDelta = this.calculateFallbackDelta(fallback, previousFallback);

      // 5. 计算业务指标（从 interview_booking_records 表获取预约统计）
      // 将时间戳转换为日期字符串 (YYYY-MM-DD)
      const currentStartDate = new Date(currentStart).toISOString().split('T')[0];
      const currentEndDate = new Date(currentEnd).toISOString().split('T')[0];
      const previousStartDate = new Date(previousStart).toISOString().split('T')[0];
      const previousEndDate = new Date(previousEnd).toISOString().split('T')[0];

      const [business, previousBusiness] = await Promise.all([
        this.getBusinessMetricsFromDatabase(currentStartDate, currentEndDate, currentRecords),
        this.getBusinessMetricsFromDatabase(previousStartDate, previousEndDate, previousRecords),
      ]);
      const businessDelta = this.calculateBusinessDelta(business, previousBusiness);

      // 6. 构建使用统计
      const usage = {
        tools: this.buildToolUsageMetrics(currentRecords),
        scenarios: this.buildScenarioUsageMetrics(currentRecords),
      };

      // 7. 队列统计
      const queue = this.calculateQueueMetrics(currentRecords, globalCounters);

      // 8. 告警统计
      const alertsSummary = await this.calculateAlertsSummary(errorLogs);

      // 9. 趋势数据
      const trends = await this.calculateTrends(timeRange);
      const responseTrend = this.buildResponseTrend(currentRecords, timeRange);
      const alertTrend = this.buildAlertTrend(errorLogs, timeRange);
      const businessTrend = this.buildBusinessTrend(currentRecords, timeRange);

      // 10. 实时状态
      const realtime = {
        processingCount: this.pendingRecords.size,
      };

      // 11. 组装返回数据
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
        realtime,
      };
    } catch (error) {
      this.logger.error('获取Dashboard数据失败:', error);
      // 返回空数据结构,避免前端崩溃
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
        overviewDelta: {
          totalMessages: 0,
          successRate: 0,
          avgDuration: 0,
        },
        fallback: {
          totalCount: 0,
          successCount: 0,
          successRate: 0,
          affectedUsers: 0,
        },
        fallbackDelta: {
          totalCount: 0,
          successRate: 0,
        },
        business: {
          consultations: { total: 0, new: 0 },
          bookings: { attempts: 0, successful: 0, failed: 0, successRate: 0 },
          conversion: { consultationToBooking: 0 },
        },
        businessDelta: {
          consultations: 0,
          bookingAttempts: 0,
          bookingSuccessRate: 0,
        },
        usage: {
          tools: [],
          scenarios: [],
        },
        queue: {
          currentProcessing: 0,
          peakProcessing: 0,
          avgQueueDuration: 0,
        },
        alertsSummary: {
          total: 0,
          lastHour: 0,
          last24Hours: 0,
          byType: [],
        },
        trends: {
          hourly: [],
        },
        responseTrend: [],
        alertTrend: [],
        businessTrend: [],
        todayUsers: [],
        recentMessages: [],
        recentErrors: [],
        realtime: {
          processingCount: 0,
        },
      };
    }
  }

  /**
   * 计算时间范围的开始和结束时间
   */
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
      case 'today':
        // 今天: 00:00:00 - 23:59:59
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        currentStart = todayStart.getTime();
        currentEnd = now;

        // 昨天: 同样时间段
        const yesterdayStart = new Date(todayStart);
        yesterdayStart.setDate(yesterdayStart.getDate() - 1);
        previousStart = yesterdayStart.getTime();
        previousEnd = currentStart;
        break;

      case 'week':
        // 本周: 7天
        currentStart = now - 7 * 24 * 60 * 60 * 1000;
        currentEnd = now;
        // 上周: 前7天
        previousStart = currentStart - 7 * 24 * 60 * 60 * 1000;
        previousEnd = currentStart;
        break;

      case 'month':
        // 本月: 30天
        currentStart = now - 30 * 24 * 60 * 60 * 1000;
        currentEnd = now;
        // 上月: 前30天
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

  /**
   * 计算概览统计
   */
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

  /**
   * 计算概览增长率
   */
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

  /**
   * 计算降级统计
   */
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

  /**
   * 计算降级增长率
   */
  private calculateFallbackDelta(
    current: ReturnType<typeof this.calculateFallbackStats>,
    previous: ReturnType<typeof this.calculateFallbackStats>,
  ) {
    return {
      totalCount: this.calculatePercentChange(current.totalCount, previous.totalCount),
      successRate: parseFloat((current.successRate - previous.successRate).toFixed(2)),
    };
  }

  /**
   * 从数据库获取业务指标
   * 预约统计从 interview_booking_records 表读取（事件驱动更新）
   */
  private async getBusinessMetricsFromDatabase(
    startDate: string,
    endDate: string,
    records: MessageProcessingRecord[],
  ) {
    const users = new Set(records.filter((r) => r.userId).map((r) => r.userId!));

    // 从 interview_booking_records 表获取预约统计
    let successfulBookings = 0;
    try {
      const bookingStats = await this.bookingRepository.getBookingStats({
        startDate,
        endDate,
      });
      successfulBookings = bookingStats.reduce((sum, item) => sum + item.bookingCount, 0);
    } catch (error) {
      this.logger.warn('[业务指标] 获取预约统计失败，使用默认值 0:', error);
    }

    // 注意：目前只统计成功预约数，预约尝试次数暂时与成功数相同
    // 未来可以添加 booking_attempts 表来跟踪所有尝试
    const bookingAttempts = successfulBookings;
    const bookingSuccessRate = bookingAttempts > 0 ? 100 : 0; // 目前只统计成功的
    const conversionRate = users.size > 0 ? (bookingAttempts / users.size) * 100 : 0;

    return {
      consultations: {
        total: users.size,
        new: users.size, // 当前时间范围内的都算新增
      },
      bookings: {
        attempts: bookingAttempts,
        successful: successfulBookings,
        failed: 0, // 目前不跟踪失败的尝试
        successRate: parseFloat(bookingSuccessRate.toFixed(2)),
      },
      conversion: {
        consultationToBooking: parseFloat(conversionRate.toFixed(2)),
      },
    };
  }

  /**
   * 计算业务指标（同步版本，用于不需要数据库查询的场景）
   * @deprecated 优先使用 getBusinessMetricsFromDatabase
   */
  private calculateBusinessMetrics(records: MessageProcessingRecord[]) {
    const users = new Set(records.filter((r) => r.userId).map((r) => r.userId!));

    // 不再从 agentInvocation 读取，因为该字段已从查询中排除以优化性能
    // 预约统计现在由 BookingDetectionService 实时更新到 interview_booking_records 表
    return {
      consultations: {
        total: users.size,
        new: users.size,
      },
      bookings: {
        attempts: 0,
        successful: 0,
        failed: 0,
        successRate: 0,
      },
      conversion: {
        consultationToBooking: 0,
      },
    };
  }

  /**
   * 计算业务指标增长率
   */
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

  /**
   * 计算队列指标
   */
  private calculateQueueMetrics(records: MessageProcessingRecord[], _globalCounters: any) {
    const queueDurations = records.filter((r) => r.queueDuration).map((r) => r.queueDuration!);
    const avgQueueDuration =
      queueDurations.length > 0
        ? queueDurations.reduce((a, b) => a + b, 0) / queueDurations.length
        : 0;

    return {
      currentProcessing: this.pendingRecords.size,
      peakProcessing: Math.max(...queueDurations, 0),
      avgQueueDuration: parseFloat(avgQueueDuration.toFixed(0)),
    };
  }

  /**
   * 计算告警汇总
   */
  private async calculateAlertsSummary(errorLogs: MonitoringErrorLog[]) {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // 当前时间范围内的告警
    const total = errorLogs.length;

    // 近1小时的告警
    const lastHour = errorLogs.filter((log) => log.timestamp >= oneHourAgo).length;

    // 近24小时的告警
    const last24Hours = errorLogs.filter((log) => log.timestamp >= oneDayAgo).length;

    // 按类型统计
    const byType = this.buildAlertTypeMetrics(errorLogs);

    return {
      total,
      lastHour,
      last24Hours,
      byType,
    };
  }

  /**
   * 计算趋势数据
   */
  private async calculateTrends(timeRange: TimeRange) {
    // 从 Supabase 读取小时统计数据
    const hours = timeRange === 'today' ? 24 : timeRange === 'week' ? 168 : 720;
    const hourlyStats = await this.databaseService.getHourlyStats(hours);

    return {
      hourly: hourlyStats,
    };
  }

  /**
   * 构建响应趋势
   */
  private buildResponseTrend(records: MessageProcessingRecord[], timeRange: TimeRange) {
    if (timeRange === 'today') {
      return this.buildResponseMinuteTrend(records);
    } else {
      return this.buildResponseDayTrend(records);
    }
  }

  /**
   * 构建告警趋势
   */
  private buildAlertTrend(logs: MonitoringErrorLog[], timeRange: TimeRange) {
    if (timeRange === 'today') {
      return this.buildAlertMinuteTrend(logs);
    } else {
      return this.buildAlertDayTrend(logs);
    }
  }

  /**
   * 构建业务趋势
   */
  private buildBusinessTrend(records: MessageProcessingRecord[], timeRange: TimeRange) {
    if (timeRange === 'today') {
      return this.buildBusinessMetricMinuteTrend(records);
    } else {
      return this.buildBusinessMetricDayTrend(records);
    }
  }

  private calculatePercentChange(current: number, previous: number): number {
    if (previous === 0) {
      return current === 0 ? 0 : 100;
    }
    return parseFloat((((current - previous) / previous) * 100).toFixed(2));
  }

  /**
   * 构建工具使用统计
   */
  private buildToolUsageMetrics(records: MessageProcessingRecord[]): ToolUsageMetric[] {
    const toolMap = new Map<string, number>();

    for (const record of records) {
      if (!record.tools || record.tools.length === 0) continue;
      for (const tool of record.tools) {
        toolMap.set(tool, (toolMap.get(tool) || 0) + 1);
      }
    }

    const total = Array.from(toolMap.values()).reduce((acc, val) => acc + val, 0);
    if (total === 0) {
      return [];
    }

    return Array.from(toolMap.entries())
      .map(([name, count]) => ({
        name,
        total: count,
        percentage: parseFloat(((count / total) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.total - a.total);
  }

  /**
   * 构建场景使用统计
   */
  private buildScenarioUsageMetrics(records: MessageProcessingRecord[]): ScenarioUsageMetric[] {
    const map = new Map<string, number>();

    for (const record of records) {
      if (!record.scenario) continue;
      map.set(record.scenario, (map.get(record.scenario) || 0) + 1);
    }

    const total = Array.from(map.values()).reduce((acc, value) => acc + value, 0);
    if (total === 0) {
      return [];
    }

    return Array.from(map.entries())
      .map(([name, count]) => ({
        name,
        total: count,
        percentage: parseFloat(((count / total) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.total - a.total);
  }

  /**
   * 构建告警类型统计
   * @param errorLogs 过滤后的错误日志（按时间范围）
   */
  private buildAlertTypeMetrics(errorLogs: MonitoringErrorLog[]): AlertTypeMetric[] {
    const typeMap = new Map<AlertErrorType | 'unknown', number>();

    // 只统计传入的错误日志，避免重复计数
    for (const log of errorLogs) {
      const type = log.alertType || 'unknown';
      typeMap.set(type, (typeMap.get(type) || 0) + 1);
    }

    const total = Array.from(typeMap.values()).reduce((acc, value) => acc + value, 0);
    if (total === 0) {
      return [];
    }

    return Array.from(typeMap.entries())
      .map(([type, count]) => ({
        type,
        count,
        percentage: parseFloat(((count / total) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * 计算平均排队时间
   */
  private calculateAverageQueueDuration(records: MessageProcessingRecord[]): number {
    const durations = records
      .filter((record) => typeof record.queueDuration === 'number')
      .map((record) => record.queueDuration || 0);

    if (durations.length === 0) {
      return 0;
    }

    const total = durations.reduce((acc, value) => acc + value, 0);
    return parseFloat((total / durations.length).toFixed(2));
  }

  private buildResponseMinuteTrend(records: MessageProcessingRecord[]): ResponseMinuteTrendPoint[] {
    const buckets = new Map<string, { durations: number[]; success: number; total: number }>();

    for (const record of records) {
      if (record.status === 'processing' || record.totalDuration === undefined) {
        continue;
      }

      const minuteKey = this.getMinuteKey(record.receivedAt);
      const bucket = buckets.get(minuteKey) || { durations: [], success: 0, total: 0 };
      bucket.durations.push(record.totalDuration || 0);
      bucket.total += 1;
      if (record.status === 'success') {
        bucket.success += 1;
      }
      buckets.set(minuteKey, bucket);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
      .map(([minute, bucket]) => ({
        minute,
        avgDuration:
          bucket.durations.length > 0
            ? parseFloat(
                (
                  bucket.durations.reduce((sum, value) => sum + value, 0) / bucket.durations.length
                ).toFixed(2),
              )
            : 0,
        messageCount: bucket.total,
        successRate:
          bucket.total > 0 ? parseFloat(((bucket.success / bucket.total) * 100).toFixed(2)) : 0,
      }));
  }

  private buildAlertMinuteTrend(logs: MonitoringErrorLog[]): AlertTrendPoint[] {
    const buckets = new Map<string, number>();

    for (const log of logs) {
      const minuteKey = this.getMinuteKey(log.timestamp);
      buckets.set(minuteKey, (buckets.get(minuteKey) || 0) + 1);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
      .map(([minute, count]) => ({ minute, count }));
  }

  private buildResponseDayTrend(records: MessageProcessingRecord[]): ResponseMinuteTrendPoint[] {
    const buckets = new Map<string, { durations: number[]; success: number; total: number }>();

    for (const record of records) {
      if (record.status === 'processing' || record.totalDuration === undefined) {
        continue;
      }

      const dayKey = this.getDayKey(record.receivedAt);
      const bucket = buckets.get(dayKey) || { durations: [], success: 0, total: 0 };
      bucket.durations.push(record.totalDuration || 0);
      bucket.total += 1;
      if (record.status === 'success') {
        bucket.success += 1;
      }
      buckets.set(dayKey, bucket);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
      .map(([minute, bucket]) => ({
        minute,
        avgDuration:
          bucket.durations.length > 0
            ? parseFloat(
                (
                  bucket.durations.reduce((sum, value) => sum + value, 0) / bucket.durations.length
                ).toFixed(2),
              )
            : 0,
        messageCount: bucket.total,
        successRate:
          bucket.total > 0 ? parseFloat(((bucket.success / bucket.total) * 100).toFixed(2)) : 0,
      }));
  }

  private buildAlertDayTrend(logs: MonitoringErrorLog[]): AlertTrendPoint[] {
    const buckets = new Map<string, number>();

    for (const log of logs) {
      const dayKey = this.getDayKey(log.timestamp);
      buckets.set(dayKey, (buckets.get(dayKey) || 0) + 1);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
      .map(([minute, count]) => ({ minute, count }));
  }

  /**
   * 构建业务指标分钟级趋势（今日）
   */
  private buildBusinessMetricMinuteTrend(
    records: MessageProcessingRecord[],
  ): import('./interfaces/monitoring.interface').BusinessMetricTrendPoint[] {
    const buckets = new Map<
      string,
      {
        users: Set<string>;
        bookingAttempts: number;
        successfulBookings: number;
      }
    >();

    for (const record of records) {
      const minuteKey = this.getMinuteKey(record.receivedAt);
      const bucket = buckets.get(minuteKey) || {
        users: new Set<string>(),
        bookingAttempts: 0,
        successfulBookings: 0,
      };

      // 统计活跃用户
      if (record.userId) {
        bucket.users.add(record.userId);
      }

      // 统计预约尝试 (从 chatResponse.messages.parts 读取)
      const chatResponse = record.agentInvocation?.response;
      if (chatResponse?.messages) {
        for (const message of chatResponse.messages) {
          if (!message.parts) continue;
          for (const part of message.parts) {
            if (part.type === 'dynamic-tool' && part.toolName === 'duliday_interview_booking') {
              bucket.bookingAttempts += 1;
              if (part.state === 'output-available' && part.output) {
                const isSuccess = this.checkBookingOutputSuccess(part.output);
                if (isSuccess) {
                  bucket.successfulBookings += 1;
                }
              }
            }
          }
        }
      }

      buckets.set(minuteKey, bucket);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
      .map(([minute, bucket]) => {
        const consultations = bucket.users.size;
        const bookingAttempts = bucket.bookingAttempts;
        const successfulBookings = bucket.successfulBookings;
        const conversionRate =
          consultations > 0 ? parseFloat(((bookingAttempts / consultations) * 100).toFixed(2)) : 0;
        const bookingSuccessRate =
          bookingAttempts > 0
            ? parseFloat(((successfulBookings / bookingAttempts) * 100).toFixed(2))
            : 0;

        return {
          minute,
          consultations,
          bookingAttempts,
          successfulBookings,
          conversionRate,
          bookingSuccessRate,
        };
      });
  }

  /**
   * 构建业务指标天级趋势（本周/本月）
   */
  private buildBusinessMetricDayTrend(
    records: MessageProcessingRecord[],
  ): import('./interfaces/monitoring.interface').BusinessMetricTrendPoint[] {
    const buckets = new Map<
      string,
      {
        users: Set<string>;
        bookingAttempts: number;
        successfulBookings: number;
      }
    >();

    for (const record of records) {
      const dayKey = this.getDayKey(record.receivedAt);
      const bucket = buckets.get(dayKey) || {
        users: new Set<string>(),
        bookingAttempts: 0,
        successfulBookings: 0,
      };

      // 统计活跃用户
      if (record.userId) {
        bucket.users.add(record.userId);
      }

      // 统计预约尝试 (从 chatResponse.messages.parts 读取)
      const chatResponse = record.agentInvocation?.response;
      if (chatResponse?.messages) {
        for (const message of chatResponse.messages) {
          if (!message.parts) continue;
          for (const part of message.parts) {
            if (part.type === 'dynamic-tool' && part.toolName === 'duliday_interview_booking') {
              bucket.bookingAttempts += 1;
              if (part.state === 'output-available' && part.output) {
                const isSuccess = this.checkBookingOutputSuccess(part.output);
                if (isSuccess) {
                  bucket.successfulBookings += 1;
                }
              }
            }
          }
        }
      }

      buckets.set(dayKey, bucket);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
      .map(([minute, bucket]) => {
        const consultations = bucket.users.size;
        const bookingAttempts = bucket.bookingAttempts;
        const successfulBookings = bucket.successfulBookings;
        const conversionRate =
          consultations > 0 ? parseFloat(((bookingAttempts / consultations) * 100).toFixed(2)) : 0;
        const bookingSuccessRate =
          bookingAttempts > 0
            ? parseFloat(((successfulBookings / bookingAttempts) * 100).toFixed(2))
            : 0;

        return {
          minute,
          consultations,
          bookingAttempts,
          successfulBookings,
          conversionRate,
          bookingSuccessRate,
        };
      });
  }

  /**
   * 构建每日统计趋势（最近7天）
   */
  private buildDailyTrend(records: MessageProcessingRecord[]): DailyStats[] {
    const buckets = new Map<
      string,
      {
        users: Set<string>;
        tokenUsage: number;
        messageCount: number;
        successCount: number;
        durations: number[];
      }
    >();

    // 只统计最近7天的数据
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    const cutoffTime = sevenDaysAgo.getTime();

    for (const record of records) {
      if (record.receivedAt < cutoffTime) {
        continue;
      }

      const dayKey = this.getDayKey(record.receivedAt);
      const bucket = buckets.get(dayKey) || {
        users: new Set<string>(),
        tokenUsage: 0,
        messageCount: 0,
        successCount: 0,
        durations: [],
      };

      // 统计活跃用户
      if (record.userId) {
        bucket.users.add(record.userId);
      }

      // 统计 token 使用量
      if (record.tokenUsage) {
        bucket.tokenUsage += record.tokenUsage;
      }

      // 统计消息数
      bucket.messageCount += 1;

      // 统计成功数
      if (record.status === 'success') {
        bucket.successCount += 1;
      }

      // 统计耗时
      if (record.totalDuration !== undefined && record.status !== 'processing') {
        bucket.durations.push(record.totalDuration);
      }

      buckets.set(dayKey, bucket);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
      .map(([date, bucket]) => {
        const avgDuration =
          bucket.durations.length > 0
            ? parseFloat(
                (bucket.durations.reduce((sum, d) => sum + d, 0) / bucket.durations.length).toFixed(
                  2,
                ),
              )
            : 0;

        // 格式化日期为 YYYY-MM-DD
        const dateObj = new Date(date);
        const formattedDate = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;

        return {
          date: formattedDate,
          tokenUsage: bucket.tokenUsage,
          uniqueUsers: bucket.users.size,
          messageCount: bucket.messageCount,
          successCount: bucket.successCount,
          avgDuration,
        };
      });
  }

  /**
   * 保存消息处理记录到数据库
   * 用于持久化实时消息详情，支持历史查询
   */
  private async saveMessageProcessingRecordToDatabase(
    record: MessageProcessingRecord,
  ): Promise<void> {
    if (!record.messageId) {
      return;
    }

    await this.databaseService.saveMessageProcessingRecord({
      messageId: record.messageId,
      chatId: record.chatId,
      userId: record.userId,
      userName: record.userName,
      managerName: record.managerName,
      receivedAt: record.receivedAt,
      messagePreview: record.messagePreview,
      replyPreview: record.replyPreview,
      replySegments: record.replySegments,
      status: record.status,
      error: record.error,
      scenario: record.scenario,
      totalDuration: record.totalDuration,
      queueDuration: record.queueDuration,
      prepDuration: record.prepDuration,
      aiStartAt: record.aiStartAt,
      aiEndAt: record.aiEndAt,
      aiDuration: record.aiDuration,
      sendDuration: record.sendDuration,
      tools: record.tools,
      tokenUsage: record.tokenUsage,
      isFallback: record.isFallback,
      fallbackSuccess: record.fallbackSuccess,
      agentInvocation: record.agentInvocation,
    });
  }

  /**
   * 从数据库获取今日活跃用户（带托管状态）
   */
  async getTodayUsersFromDatabase(): Promise<TodayUser[]> {
    const dbUsers = await this.databaseService.getTodayActiveUsers();

    // 批量获取托管状态
    const chatIds = dbUsers.map((u) => u.chatId);
    const pausedSet = new Set<string>();

    // 从 Supabase 获取托管状态
    for (const chatId of chatIds) {
      const status = await this.databaseService.getUserHostingStatus(chatId);
      if (status.isPaused) {
        pausedSet.add(chatId);
      }
    }

    return dbUsers.map((user) => ({
      chatId: user.chatId,
      odId: user.userId || user.chatId,
      odName: user.userName || user.chatId, // Fixed: use userName instead of odName
      groupName: user.groupName,
      messageCount: user.messageCount,
      tokenUsage: user.tokenUsage,
      firstActiveAt: user.firstActiveAt, // 已经是 number 类型（时间戳）
      lastActiveAt: user.lastActiveAt, // 已经是 number 类型（时间戳）
      isPaused: pausedSet.has(user.chatId),
    }));
  }

  /**
   * 获取指定日期的活跃用户（带托管状态）
   * @param date 日期字符串 (YYYY-MM-DD)
   */
  async getUsersByDate(date: string): Promise<TodayUser[]> {
    const dbUsers = await this.databaseService.getActiveUsersByDate(date);

    // 批量获取托管状态
    const chatIds = dbUsers.map((u) => u.chatId);
    const pausedSet = new Set<string>();

    // 从 Supabase 获取托管状态
    for (const chatId of chatIds) {
      const status = await this.databaseService.getUserHostingStatus(chatId);
      if (status.isPaused) {
        pausedSet.add(chatId);
      }
    }

    return dbUsers.map((user) => ({
      chatId: user.chatId,
      odId: user.userId || user.chatId,
      odName: user.userName || user.chatId, // Fixed: use userName instead of odName
      groupName: user.groupName,
      messageCount: user.messageCount,
      tokenUsage: user.tokenUsage,
      firstActiveAt: user.firstActiveAt,
      lastActiveAt: user.lastActiveAt,
      isPaused: pausedSet.has(user.chatId),
    }));
  }

  /**
   * 获取近1月咨询用户趋势数据
   */
  async getUserTrend(): Promise<
    Array<{
      date: string;
      userCount: number;
      messageCount: number;
    }>
  > {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30); // 过去30天

    return this.databaseService.getDailyUserStats(startDate, endDate);
  }

  // ========== 私有辅助方法 ==========

  /**
   * 保存消息处理记录到数据库
   */
  private async saveRecordToDatabase(record: MessageProcessingRecord): Promise<void> {
    // 保存详细记录
    await this.databaseService.saveDetailRecord(record);

    this.logger.debug(`已保存消息处理记录到数据库 [${record.messageId}]`);
  }

  /**
   * 保存错误日志
   * @param messageId 消息ID
   * @param error 错误信息
   * @param alertType 错误类型（用于错误分布统计）
   */
  private saveErrorLog(messageId: string, error: string, alertType?: AlertErrorType): void {
    const errorLog: MonitoringErrorLog = {
      messageId,
      timestamp: Date.now(),
      error,
      alertType: alertType || 'unknown',
    };

    // 异步保存到数据库
    this.databaseService.saveErrorLog(errorLog).catch((err) => {
      this.logger.warn(`保存错误日志到数据库失败 [${messageId}]:`, err);
    });
  }

  /**
   * 清理超时的临时记录（防止内存泄漏）
   */
  private cleanupPendingRecords(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [messageId, record] of this.pendingRecords.entries()) {
      if (now - record.receivedAt > this.PENDING_RECORD_TTL_MS) {
        // 标记为失败并保存
        record.status = 'failure';
        record.error = '超时未完成（1小时）';
        record.totalDuration = now - record.receivedAt;

        this.saveRecordToDatabase(record).catch((err) => {
          this.logger.warn(`保存超时记录失败 [${messageId}]:`, err);
        });

        this.pendingRecords.delete(messageId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.warn(`清理了 ${cleanedCount} 条超时的临时记录`);
    }
  }

  // ========================================
  // 辅助方法 - 时间格式化
  // ========================================

  /**
   * 获取分钟级时间键（YYYY-MM-DD HH:mm）
   */
  private getMinuteKey(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  /**
   * 获取天级时间键（YYYY-MM-DD）
   */
  private getDayKey(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * 检查预约工具输出是否表示成功
   * 从工具的 output.object.success 字段判断
   *
   * @param output 工具输出对象
   * @returns true=预约成功, false=预约失败
   */
  private checkBookingOutputSuccess(output: Record<string, unknown>): boolean {
    // output 结构: { type: 'object', object: { success: boolean, code: number, message: string, ... } }
    if (output.type === 'object' && output.object) {
      const obj = output.object as any;
      // 明确判断 success 字段
      return obj.success === true;
    }
    // 如果结构不符合预期，返回 false
    return false;
  }

  /**
   * 发送预约成功的飞书通知
   * 从 record 和 part 中提取必要信息，调用 FeishuBookingService
   *
   * @param record 消息处理记录
   * @param part 工具执行 part（包含 input 和 output）
   */
  private async sendBookingSuccessNotification(
    record: MessageProcessingRecord,
    part: any,
  ): Promise<void> {
    try {
      // 从 part.input 提取预约输入信息
      const input = part.input || {};
      // 从 part.output.object 提取预约结果信息
      const output = part.output?.object || {};

      // 构建飞书通知所需的信息
      const bookingInfo = {
        candidateName: input.name || record.userName,
        chatId: record.chatId,
        brandName: input.brandName,
        storeName: input.storeName,
        interviewTime: input.interviewTime,
        contactInfo: input.phone,
        toolOutput: {
          message: output.message,
          booking_id: output.booking_id || output.bookingId,
          code: output.code,
        },
      };

      this.logger.log(
        `🎉 预约成功，准备发送飞书通知: ${bookingInfo.candidateName} - ${bookingInfo.interviewTime}`,
      );

      // 调用飞书通知服务
      const success = await this.feishuBookingService.sendBookingNotification(bookingInfo);

      if (success) {
        this.logger.log('飞书预约通知发送成功');
      } else {
        this.logger.warn('飞书预约通知发送失败（服务返回 false）');
      }
    } catch (error) {
      // 错误已在调用方捕获，这里只记录详细信息
      this.logger.error('发送飞书预约通知时发生异常:', error);
      throw error;
    }
  }

  /**
   * 获取消息统计数据（聚合查询，轻量级）
   * 用于消息记录页面顶部统计
   */
  async getMessageStatsAsync(
    startTime: number,
    endTime: number,
  ): Promise<{
    total: number;
    success: number;
    failed: number;
    avgDuration: number;
  }> {
    return this.databaseService.getMessageStats(startTime, endTime);
  }

  /**
   * 获取 Dashboard 概览数据（优化版 - 使用 SQL 聚合查询）
   * 用于 Dashboard 页面
   *
   * v2.0: 使用 Supabase RPC 函数进行数据库聚合，替代应用层计算
   * 优势：避免拉取全量数据到 Node.js 内存，减少数据传输和计算开销
   */
  async getDashboardOverviewAsync(timeRange: TimeRange = 'today'): Promise<{
    timeRange: string;
    overview: any;
    overviewDelta: any;
    dailyTrend: DailyStats[];
    tokenTrend: any[];
    businessTrend: any[];
    responseTrend: any[];
    business: any;
    businessDelta: any;
    fallback: any;
    fallbackDelta: any;
  }> {
    try {
      // 1. 计算时间范围
      const timeRanges = this.calculateTimeRanges(timeRange);
      const { currentStart, currentEnd, previousStart, previousEnd } = timeRanges;

      const currentStartDate = new Date(currentStart);
      const currentEndDate = new Date(currentEnd);
      const previousStartDate = new Date(previousStart);
      const previousEndDate = new Date(previousEnd);

      // 计算最近 7 天的时间范围（用于 dailyTrend）
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      sevenDaysAgo.setHours(0, 0, 0, 0);

      // 2. 分层查询路由：today 用实时+聚合混合，其他时间范围全部用聚合表
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
        // === 实时查询：已聚合的完整小时 + 当前小时 RPC ===
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
          // 今日已完成小时概览 → 聚合表
          this.hourlyStatsAggregator.getOverviewFromHourly(currentStartDate, currentHourStart),
          // 当前小时概览 → 实时 RPC
          this.monitoringRepository.getDashboardOverviewStats(currentHourStart, currentEndDate),
          // 今日已完成小时降级 → 聚合表
          this.hourlyStatsAggregator.getFallbackFromHourly(currentStartDate, currentHourStart),
          // 当前小时降级 → 实时 RPC
          this.monitoringRepository.getDashboardFallbackStats(currentHourStart, currentEndDate),
          // 昨日概览（用于增长率）→ 聚合表
          this.hourlyStatsAggregator.getOverviewFromHourly(previousStartDate, previousEndDate),
          // 昨日降级 → 聚合表
          this.hourlyStatsAggregator.getFallbackFromHourly(previousStartDate, previousEndDate),
          // 每日趋势（最近 7 天）→ 聚合表
          this.hourlyStatsAggregator.getDailyTrendFromHourly(sevenDaysAgo, new Date()),
          // 分钟级趋势（今日实时）→ RPC
          this.monitoringRepository.getDashboardMinuteTrend(currentStartDate, currentEndDate, 5),
          // Token 趋势：已完成小时 → 聚合表
          this.hourlyStatsAggregator.getHourlyTrendFromHourly(currentStartDate, currentHourStart),
          // Token 趋势：当前小时 → 实时 RPC
          this.monitoringRepository.getDashboardHourlyTrend(currentHourStart, currentEndDate),
        ]);

        // 合并当前周期数据（历史小时 + 当前小时实时）
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
        // === 非实时查询（week/month）：全部从 monitoring_hourly_stats 聚合 ===
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
        // 非实时：响应趋势和 Token 趋势均使用每日聚合数据
        minuteTrend = currentPeriodDaily;
        tokenTrendData = currentPeriodDaily;
      }

      // 3. 构建概览指标
      const overview = {
        totalMessages: currentOverview.totalMessages,
        successCount: currentOverview.successCount,
        failureCount: currentOverview.failureCount,
        successRate: currentOverview.successRate,
        avgDuration: currentOverview.avgDuration,
        activeUsers: currentOverview.activeUsers,
        activeChats: currentOverview.activeChats,
      };

      // 4. 计算增长率
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

      // 5. 构建降级统计
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

      // 6. 业务指标（预约统计需要从 agentInvocation 提取，暂时查询详细数据）
      // TODO: 后续可以考虑将预约工具调用数据单独存储，避免拉取 agentInvocation
      // 注意：这里仍需要拉取部分详细记录来提取预约工具调用信息
      const businessRecords = await this.databaseService.getDetailRecordsByTimeRange(timeRange);
      const business = this.calculateBusinessMetrics(businessRecords);

      // 业务指标的增长率计算：使用简化版本（基于当前和前一周期的用户数）
      // 避免再次查询前一周期的详细数据
      const previousBusiness = {
        consultations: { total: 0, new: 0 },
        bookings: { attempts: 0, successful: 0, failed: 0, successRate: 0 },
        conversion: { consultationToBooking: 0 },
      };
      const businessDelta = this.calculateBusinessDelta(business, previousBusiness);

      // 7. 构建趋势数据
      const formattedDailyTrend: DailyStats[] = dailyTrend.map((item) => ({
        date: item.date,
        messageCount: item.messageCount,
        successCount: item.successCount,
        avgDuration: item.avgDuration,
        tokenUsage: item.tokenUsage,
        uniqueUsers: item.uniqueUsers,
      }));

      // 8. 构建响应时间趋势
      const responseTrend =
        timeRange === 'today'
          ? (minuteTrend as any[]).map((item) => ({
              minute: item.minute,
              avgDuration: item.avgDuration,
              messageCount: item.messageCount,
              successRate:
                item.messageCount > 0
                  ? parseFloat(((item.successCount / item.messageCount) * 100).toFixed(2))
                  : 0,
            }))
          : (minuteTrend as any[]).map((item) => ({
              minute: item.date, // dailyTrend 返回 date 字段
              avgDuration: item.avgDuration,
              messageCount: item.messageCount,
              successRate:
                item.messageCount > 0
                  ? parseFloat(((item.successCount / item.messageCount) * 100).toFixed(2))
                  : 0,
            }));

      // 9. 业务趋势（从分钟趋势数据构建）
      const businessTrend = this.buildBusinessTrendFromMinuteTrend(businessRecords, timeRange);

      // 10. Token 消耗趋势（本日为小时级，本周/本月为天级）
      const tokenTrend =
        timeRange === 'today'
          ? (tokenTrendData as any[]).map((item) => ({
              time: item.hour,
              tokenUsage: item.tokenUsage,
              messageCount: item.messageCount,
            }))
          : (tokenTrendData as any[]).map((item) => ({
              time: item.date,
              tokenUsage: item.tokenUsage,
              messageCount: item.messageCount,
            }));

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
   * 获取前一个时间范围（用于计算增长率）
   */
  private getPreviousTimeRange(timeRange: TimeRange): TimeRange {
    // 简化处理：都返回相同的时间范围类型
    // 实际的时间偏移在 calculateTimeRanges 中处理
    return timeRange;
  }

  /**
   * 从业务记录构建业务趋势（兼容方法）
   */
  private buildBusinessTrendFromMinuteTrend(
    records: MessageProcessingRecord[],
    timeRange: TimeRange,
  ): any[] {
    // 复用原有的趋势构建逻辑
    return this.buildBusinessTrend(records, timeRange);
  }

  /**
   * 获取 System 监控数据（轻量级）
   * 用于 System 页面
   */
  async getSystemMonitoringAsync(): Promise<{
    queue: any;
    alertsSummary: any;
    alertTrend: any[];
  }> {
    try {
      // 并行查询必需的数据（仅 3 个查询）
      const [currentRecords, errorLogs, globalCounters] = await Promise.all([
        this.databaseService.getRecordsByTimeRange(Date.now() - 24 * 60 * 60 * 1000, Date.now()),
        this.databaseService.getErrorLogsByTimeRange('today'),
        this.cacheService.getCounters(),
      ]);

      // 计算队列统计
      const queue = this.calculateQueueMetrics(currentRecords, globalCounters);

      // 计算告警统计
      const alertsSummary = await this.calculateAlertsSummary(errorLogs);

      // 构建告警趋势
      const alertTrend = this.buildAlertTrend(errorLogs, 'today');

      return {
        queue,
        alertsSummary,
        alertTrend,
      };
    } catch (error) {
      this.logger.error('获取System监控数据失败:', error);
      throw error;
    }
  }

  /**
   * 获取趋势数据（独立接口）
   * 用于各类趋势图表
   */
  async getTrendsDataAsync(timeRange: TimeRange = 'today'): Promise<{
    dailyTrend: any;
    responseTrend: any[];
    alertTrend: any[];
    businessTrend: any[];
  }> {
    try {
      const timeRanges = this.calculateTimeRanges(timeRange);
      const { currentStart, currentEnd } = timeRanges;

      // 并行查询
      const [currentRecords, errorLogs, trends] = await Promise.all([
        this.databaseService.getRecordsByTimeRange(currentStart, currentEnd),
        this.databaseService.getErrorLogsByTimeRange(timeRange),
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
   * 获取详细指标数据（用于 /monitoring/metrics 接口）
   */
  async getMetricsDataAsync(): Promise<MetricsData> {
    try {
      // 并行读取数据
      const [detailRecords, hourlyStats, globalCounters, recentErrors] = await Promise.all([
        this.databaseService.getRecentDetailRecords(50),
        this.databaseService.getHourlyStats(72),
        this.cacheService.getCounters(),
        this.databaseService.getRecentErrors(20),
      ]);

      // 计算百分位数（过滤超时和失败记录，只统计正常完成的请求）
      // 超时阈值: 60秒 (避免被1小时超时清理的记录污染统计)
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

      // 获取最慢的记录
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

      // 返回空数据
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
        percentiles: {
          p50: 0,
          p95: 0,
          p99: 0,
          p999: 0,
        },
        slowestRecords: [],
        recentAlertCount: 0,
      };
    }
  }

  /**
   * 从数组计算百分位数
   */
  private calculatePercentilesFromArray(values: number[]): {
    p50: number;
    p95: number;
    p99: number;
    p999: number;
  } {
    if (values.length === 0) {
      return { p50: 0, p95: 0, p99: 0, p999: 0 };
    }

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
  // 定时聚合任务
  // ========================================

  /**
   * 小时统计聚合定时任务
   * 每小时第 5 分钟执行（避开整点高峰）
   */
  @Cron('5 * * * *', {
    name: 'aggregateHourlyStats',
    timeZone: 'Asia/Shanghai',
  })
  async aggregateHourlyStats(): Promise<void> {
    try {
      const startTime = Date.now();
      this.logger.log('开始执行小时统计聚合任务...');

      // 1. 计算上一个完整小时的时间范围
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

      // 2. 调用数据库级聚合 RPC（替代 TypeScript 侧聚合，解决 limit 2000 bug）
      const aggregated = await this.monitoringRepository.aggregateHourlyStats(
        lastHourStart,
        lastHourEnd,
      );

      if (!aggregated || aggregated.messageCount === 0) {
        this.logger.warn(`该小时无数据记录,跳过聚合: ${hourKey}`);
        return;
      }

      // 3. 构造小时统计对象
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

      // 4. 保存到 Supabase
      await this.databaseService.saveHourlyStats(hourlyStats);

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
}

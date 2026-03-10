import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import { HttpClientFactory } from '@core/client-http';
import { MessageProcessingRepository, UserHostingRepository } from '@core/supabase/repositories';
import {
  MessageProcessingRecord,
  HourlyStats,
  MonitoringErrorLog,
  TimeRange,
} from './interfaces/monitoring.interface';

/**
 * 监控数据库服务
 * 负责将监控数据持久化到 Supabase
 *
 * 数据表：
 * - message_processing_records: 详细消息处理记录（已存在）
 * - monitoring_hourly_stats: 小时级聚合统计（新建）
 * - monitoring_error_logs: 错误日志（新建）
 */
@Injectable()
export class MonitoringDatabaseService implements OnModuleInit {
  private readonly logger = new Logger(MonitoringDatabaseService.name);

  // HTTP Client
  private supabaseHttpClient!: AxiosInstance;

  // 表名常量
  private readonly TABLE_RECORDS = 'message_processing_records';
  private readonly TABLE_HOURLY_STATS = 'monitoring_hourly_stats';
  private readonly TABLE_ERROR_LOGS = 'monitoring_error_logs';
  // 查询缓存（简单内存缓存，避免频繁查询）
  private queryCache = new Map<string, { data: any; timestamp: number }>();
  private readonly CACHE_TTL_MS = 60 * 1000; // 1 分钟缓存

  constructor(
    private readonly messageProcessingRepository: MessageProcessingRepository,
    private readonly userHostingRepository: UserHostingRepository,
    private readonly configService: ConfigService,
    private readonly httpClientFactory: HttpClientFactory,
  ) {}

  async onModuleInit() {
    const supabaseUrl = this.configService.get<string>('NEXT_PUBLIC_SUPABASE_URL');
    const supabaseKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      this.logger.error('Missing Supabase credentials');
      return;
    }

    // 创建 Supabase REST API 客户端（超时 120 秒，与 SupabaseService 保持一致）
    this.supabaseHttpClient = this.httpClientFactory.createWithBearerAuth(
      {
        baseURL: `${supabaseUrl}/rest/v1`,
        timeout: 120000, // 120 秒超时，处理慢查询
        headers: {
          'Content-Type': 'application/json',
          apikey: supabaseKey,
        },
      },
      supabaseKey,
    );

    // 每 5 分钟清理过期缓存，防止内存泄漏
    setInterval(() => this.cleanExpiredCache(), 5 * 60 * 1000);
  }

  /**
   * 清理过期的查询缓存
   */
  private cleanExpiredCache(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, value] of this.queryCache.entries()) {
      if (now - value.timestamp > this.CACHE_TTL_MS) {
        this.queryCache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`已清理 ${cleanedCount} 条过期缓存`);
    }
  }

  // ========================================
  // 详细记录（MessageProcessingRecord）
  // ========================================

  /**
   * 保存消息处理记录到数据库
   * 使用 SupabaseService 已有的 saveMessageProcessingRecord 方法
   */
  async saveDetailRecord(record: MessageProcessingRecord): Promise<void> {
    try {
      await this.messageProcessingRepository.saveMessageProcessingRecord({
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
        batchId: record.batchId,
        isPrimary: record.isPrimary,
      });
    } catch (error) {
      this.logger.error(`保存消息记录异常 [${record.messageId}]:`, error);
    }
  }

  /**
   * 批量保存消息处理记录
   * 逐条调用 saveDetailRecord (SupabaseService 没有批量 API)
   */
  async saveDetailRecordsBatch(records: MessageProcessingRecord[]): Promise<void> {
    if (records.length === 0) return;

    try {
      await Promise.all(records.map((record) => this.saveDetailRecord(record)));
      this.logger.log(`批量保存消息记录成功 (${records.length} 条)`);
    } catch (error) {
      this.logger.error(`批量保存消息记录异常 (${records.length} 条):`, error);
    }
  }

  /**
   * 按时间范围查询消息处理记录
   * 注意：添加了 limit 限制，避免查询过多数据导致超时
   */
  async getDetailRecordsByTimeRange(range: TimeRange): Promise<MessageProcessingRecord[]> {
    try {
      const cutoffTime = this.getTimeRangeCutoff(range);

      // 根据时间范围设置不同的 limit
      const limitByRange = {
        today: 2000, // 今日最多 2000 条
        week: 5000, // 本周最多 5000 条
        month: 10000, // 本月最多 10000 条
      };

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

  /**
   * 查询最近 N 条消息记录
   */
  async getRecentDetailRecords(limit: number = 50): Promise<MessageProcessingRecord[]> {
    try {
      const result = await this.messageProcessingRepository.getMessageProcessingRecords({ limit });
      return result.records as unknown as MessageProcessingRecord[];
    } catch (error) {
      this.logger.error('查询最近消息记录异常:', error);
      return [];
    }
  }

  /**
   * 按时间范围查询消息处理记录
   */
  async getRecordsByTimeRange(
    startTime: number,
    endTime: number,
  ): Promise<MessageProcessingRecord[]> {
    try {
      // 查询缓存键
      const cacheKey = `records_${startTime}_${endTime}`;
      const cached = this.queryCache.get(cacheKey);

      // 如果缓存有效，直接返回
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        this.logger.debug(`使用缓存数据: ${cacheKey}`);
        return cached.data;
      }

      const startDate = new Date(startTime).toISOString();
      const endDate = new Date(endTime).toISOString();

      // 优化：增加超时时间，添加查询限制
      const response = await this.supabaseHttpClient.get<any[]>('/message_processing_records', {
        params: {
          and: `(received_at.gte.${startDate},received_at.lt.${endDate})`,
          order: 'received_at.desc',
          limit: 2000, // 限制为 2000 条以减少数据传输
          // 只选择需要的字段，排除大字段以提升查询性能
          select:
            'message_id,chat_id,user_id,user_name,manager_name,received_at,message_preview,reply_preview,status,ai_duration,total_duration,scenario,tools,token_usage,is_fallback,fallback_success,alert_type',
        },
        timeout: 30000, // 30 秒超时（Supabase 查询可能较慢）
      });

      if (!response.data || response.data.length === 0) {
        // 缓存空结果
        this.queryCache.set(cacheKey, { data: [], timestamp: Date.now() });
        return [];
      }

      // 转换 snake_case 到 camelCase
      const records = response.data.map((record: any) => ({
        messageId: record.message_id,
        chatId: record.chat_id,
        userId: record.user_id,
        userName: record.user_name,
        managerName: record.manager_name,
        scenario: record.scenario,
        receivedAt: new Date(record.received_at).getTime(),
        aiStartAt: record.ai_start_at ? new Date(record.ai_start_at).getTime() : undefined,
        aiEndAt: record.ai_end_at ? new Date(record.ai_end_at).getTime() : undefined,
        sendStartAt: record.send_start_at ? new Date(record.send_start_at).getTime() : undefined,
        sendEndAt: record.send_end_at ? new Date(record.send_end_at).getTime() : undefined,
        totalDuration: record.total_duration,
        aiDuration: record.ai_duration,
        sendDuration: record.send_duration,
        queueDuration: record.queue_duration,
        prepDuration: record.prep_duration,
        status: record.status,
        error: record.error,
        isFallback: record.is_fallback,
        fallbackSuccess: record.fallback_success,
        messagePreview: record.message_preview,
        replyPreview: record.reply_preview,
        tokenUsage: record.token_usage,
        tools: record.tools,
        replySegments: record.reply_segments,
        alertType: record.alert_type,
      }));

      // 缓存查询结果
      this.queryCache.set(cacheKey, { data: records, timestamp: Date.now() });

      return records;
    } catch (error) {
      this.logger.error('按时间范围查询消息记录失败:', error);
      return [];
    }
  }

  /**
   * 获取消息统计（聚合查询，轻量级）
   * 使用 Supabase 的 count 功能进行数据库级聚合，避免拉取全量数据
   */
  async getMessageStats(
    startTime: number,
    endTime: number,
  ): Promise<{
    total: number;
    success: number;
    failed: number;
    avgDuration: number;
  }> {
    try {
      const startDate = new Date(startTime).toISOString();
      const endDate = new Date(endTime).toISOString();

      // 只统计主消息（is_primary=true 或 is_primary=null 的旧数据）
      // 排除被聚合的次要消息（is_primary=false）
      const isPrimaryFilter = '(is_primary.eq.true,is_primary.is.null)';

      // 并行查询各项统计（使用 select=count 进行数据库级聚合）
      const [totalRes, successRes, failedRes, avgDurationRes] = await Promise.all([
        // 总数
        this.supabaseHttpClient.get<any[]>('/message_processing_records', {
          params: {
            and: `(received_at.gte.${startDate},received_at.lt.${endDate})`,
            or: isPrimaryFilter,
            select: 'count',
          },
          headers: { Prefer: 'count=exact' },
          timeout: 5000,
        }),
        // 成功数
        this.supabaseHttpClient.get<any[]>('/message_processing_records', {
          params: {
            and: `(received_at.gte.${startDate},received_at.lt.${endDate},status.eq.success)`,
            or: isPrimaryFilter,
            select: 'count',
          },
          headers: { Prefer: 'count=exact' },
          timeout: 5000,
        }),
        // 失败数
        this.supabaseHttpClient.get<any[]>('/message_processing_records', {
          params: {
            and: `(received_at.gte.${startDate},received_at.lt.${endDate},status.in.(failure,failed))`,
            or: isPrimaryFilter,
            select: 'count',
          },
          headers: { Prefer: 'count=exact' },
          timeout: 5000,
        }),
        // 平均耗时（仅查询 ai_duration 字段用于计算）
        this.supabaseHttpClient.get<any[]>('/message_processing_records', {
          params: {
            and: `(received_at.gte.${startDate},received_at.lt.${endDate},status.eq.success)`,
            or: isPrimaryFilter,
            select: 'ai_duration',
            limit: 1000, // 最多取 1000 条用于计算平均值
          },
          timeout: 5000,
        }),
      ]);

      // 从响应头中提取 count
      const total = parseInt(totalRes.headers['content-range']?.split('/')[1] || '0', 10);
      const success = parseInt(successRes.headers['content-range']?.split('/')[1] || '0', 10);
      const failed = parseInt(failedRes.headers['content-range']?.split('/')[1] || '0', 10);

      // 计算平均耗时
      const durations = (avgDurationRes.data || [])
        .map((r: any) => r.ai_duration)
        .filter((d: number) => d !== null && d !== undefined && d > 0);

      const avgDuration =
        durations.length > 0
          ? Math.round(durations.reduce((sum: number, d: number) => sum + d, 0) / durations.length)
          : 0;

      this.logger.debug(
        `消息统计: total=${total}, success=${success}, failed=${failed}, avgDuration=${avgDuration}ms`,
      );

      return { total, success, failed, avgDuration };
    } catch (error) {
      this.logger.error('获取消息统计失败:', error);
      return { total: 0, success: 0, failed: 0, avgDuration: 0 };
    }
  }

  // ========================================
  // 小时统计（HourlyStats）- TODO: 需要实现
  // ========================================

  /**
   * 保存小时级聚合统计（UPSERT）
   */
  async saveHourlyStats(stats: HourlyStats): Promise<void> {
    try {
      const statsRecord = {
        hour: stats.hour,
        message_count: stats.messageCount,
        success_count: stats.successCount,
        failure_count: stats.failureCount,
        success_rate: stats.successRate,
        avg_duration: stats.avgDuration,
        min_duration: stats.minDuration,
        max_duration: stats.maxDuration,
        p50_duration: stats.p50Duration,
        p95_duration: stats.p95Duration,
        p99_duration: stats.p99Duration,
        avg_ai_duration: stats.avgAiDuration,
        avg_send_duration: stats.avgSendDuration,
        active_users: stats.activeUsers,
        active_chats: stats.activeChats,
        total_token_usage: stats.totalTokenUsage ?? 0,
        fallback_count: stats.fallbackCount ?? 0,
        fallback_success_count: stats.fallbackSuccessCount ?? 0,
        scenario_stats: stats.scenarioStats ?? {},
        tool_stats: stats.toolStats ?? {},
      };

      await this.supabaseHttpClient.post(`/monitoring_hourly_stats`, statsRecord, {
        headers: {
          Prefer: 'resolution=merge-duplicates',
        },
      });
    } catch (error) {
      this.logger.error(`保存小时统计失败 [${stats.hour}]:`, error);
    }
  }

  /**
   * 批量保存小时统计
   */
  async saveHourlyStatsBatch(statsList: HourlyStats[]): Promise<void> {
    if (!statsList || statsList.length === 0) return;

    try {
      const statsRecords = statsList.map((stats) => ({
        hour: stats.hour,
        message_count: stats.messageCount,
        success_count: stats.successCount,
        failure_count: stats.failureCount,
        success_rate: stats.successRate,
        avg_duration: stats.avgDuration,
        min_duration: stats.minDuration,
        max_duration: stats.maxDuration,
        p50_duration: stats.p50Duration,
        p95_duration: stats.p95Duration,
        p99_duration: stats.p99Duration,
        avg_ai_duration: stats.avgAiDuration,
        avg_send_duration: stats.avgSendDuration,
        active_users: stats.activeUsers,
        active_chats: stats.activeChats,
        total_token_usage: stats.totalTokenUsage ?? 0,
        fallback_count: stats.fallbackCount ?? 0,
        fallback_success_count: stats.fallbackSuccessCount ?? 0,
        scenario_stats: stats.scenarioStats ?? {},
        tool_stats: stats.toolStats ?? {},
      }));

      await this.supabaseHttpClient.post(`/monitoring_hourly_stats`, statsRecords, {
        headers: {
          Prefer: 'resolution=merge-duplicates',
        },
      });

      this.logger.log(`批量保存 ${statsList.length} 条小时统计成功`);
    } catch (error) {
      this.logger.error(`批量保存小时统计失败:`, error);
    }
  }

  /**
   * 查询最近 N 小时的统计数据
   */
  async getHourlyStats(hours: number = 72): Promise<HourlyStats[]> {
    try {
      const cutoffTime = new Date();
      cutoffTime.setHours(cutoffTime.getHours() - hours);

      const response = await this.supabaseHttpClient.get(`/monitoring_hourly_stats`, {
        params: {
          select: '*',
          hour: `gte.${cutoffTime.toISOString()}`,
          order: 'hour.desc',
        },
      });

      return (response.data || []).map((row: any) => ({
        hour: row.hour,
        messageCount: row.message_count,
        successCount: row.success_count,
        failureCount: row.failure_count,
        successRate: row.success_rate,
        avgDuration: row.avg_duration,
        minDuration: row.min_duration,
        maxDuration: row.max_duration,
        p50Duration: row.p50_duration,
        p95Duration: row.p95_duration,
        p99Duration: row.p99_duration,
        avgAiDuration: row.avg_ai_duration,
        avgSendDuration: row.avg_send_duration,
        activeUsers: row.active_users,
        activeChats: row.active_chats,
        totalTokenUsage: row.total_token_usage ?? 0,
        fallbackCount: row.fallback_count ?? 0,
        fallbackSuccessCount: row.fallback_success_count ?? 0,
        scenarioStats: row.scenario_stats ?? {},
        toolStats: row.tool_stats ?? {},
      }));
    } catch (error) {
      this.logger.error(`查询小时统计失败:`, error);
      return [];
    }
  }

  /**
   * 按日期范围查询小时统计（用于历史 Dashboard 查询）
   * 无 limit 限制（一年 8760 行，内存完全可控）
   */
  async getHourlyStatsByDateRange(startDate: Date, endDate: Date): Promise<HourlyStats[]> {
    try {
      const response = await this.supabaseHttpClient.get(`/monitoring_hourly_stats`, {
        params: {
          select: '*',
          and: `(hour.gte.${startDate.toISOString()},hour.lt.${endDate.toISOString()})`,
          order: 'hour.asc',
        },
      });

      return (response.data || []).map((row: any) => ({
        hour: row.hour,
        messageCount: row.message_count,
        successCount: row.success_count,
        failureCount: row.failure_count,
        successRate: row.success_rate,
        avgDuration: row.avg_duration,
        minDuration: row.min_duration,
        maxDuration: row.max_duration,
        p50Duration: row.p50_duration,
        p95Duration: row.p95_duration,
        p99Duration: row.p99_duration,
        avgAiDuration: row.avg_ai_duration,
        avgSendDuration: row.avg_send_duration,
        activeUsers: row.active_users,
        activeChats: row.active_chats,
        totalTokenUsage: row.total_token_usage ?? 0,
        fallbackCount: row.fallback_count ?? 0,
        fallbackSuccessCount: row.fallback_success_count ?? 0,
        scenarioStats: row.scenario_stats ?? {},
        toolStats: row.tool_stats ?? {},
      }));
    } catch (error) {
      this.logger.error(`按日期范围查询小时统计失败:`, error);
      return [];
    }
  }

  // ========================================
  // 错误日志（MonitoringErrorLog）
  // ========================================

  /**
   * 保存错误日志到 Supabase
   */
  async saveErrorLog(log: MonitoringErrorLog): Promise<void> {
    try {
      const errorRecord = {
        message_id: log.messageId,
        timestamp: log.timestamp, // 直接使用 Unix 毫秒时间戳
        error: log.error,
        alert_type: log.alertType,
      };

      await this.supabaseHttpClient.post(`/monitoring_error_logs`, errorRecord, {
        headers: {
          Prefer: 'resolution=merge-duplicates',
        },
      });
    } catch (error) {
      this.logger.error(`保存错误日志失败 [${log.messageId}]:`, error);
    }
  }

  /**
   * 批量保存错误日志
   */
  async saveErrorLogsBatch(logs: MonitoringErrorLog[]): Promise<void> {
    if (!logs || logs.length === 0) return;

    try {
      const errorRecords = logs.map((log) => ({
        message_id: log.messageId,
        timestamp: log.timestamp, // 直接使用 Unix 毫秒时间戳
        error: log.error,
        alert_type: log.alertType,
      }));

      await this.supabaseHttpClient.post(`/monitoring_error_logs`, errorRecords, {
        headers: {
          Prefer: 'resolution=merge-duplicates',
        },
      });

      this.logger.log(`批量保存 ${logs.length} 条错误日志成功`);
    } catch (error) {
      this.logger.error(`批量保存错误日志失败:`, error);
    }
  }

  /**
   * 查询最近的错误日志
   */
  async getRecentErrors(limit: number = 20): Promise<MonitoringErrorLog[]> {
    try {
      const response = await this.supabaseHttpClient.get(`/monitoring_error_logs`, {
        params: {
          select: '*',
          order: 'timestamp.desc',
          limit,
        },
      });

      return (response.data || []).map((row: any) => ({
        messageId: row.message_id,
        timestamp: Number(row.timestamp), // timestamp 已经是 bigint
        error: row.error,
        alertType: row.alert_type,
      }));
    } catch (error) {
      this.logger.error('查询错误日志失败:', error);
      return [];
    }
  }

  /**
   * 按时间范围查询错误日志
   */
  async getErrorLogsByTimeRange(range: TimeRange): Promise<MonitoringErrorLog[]> {
    try {
      const cutoff = this.getTimeRangeCutoff(range);
      const cutoffTimestamp = cutoff.getTime(); // 转换为 Unix 毫秒时间戳

      const response = await this.supabaseHttpClient.get(`/monitoring_error_logs`, {
        params: {
          select: '*',
          timestamp: `gte.${cutoffTimestamp}`,
          order: 'timestamp.desc',
        },
      });

      return (response.data || []).map((row: any) => ({
        messageId: row.message_id,
        timestamp: Number(row.timestamp), // timestamp 已经是 bigint
        error: row.error,
        alertType: row.alert_type,
      }));
    } catch (error) {
      this.logger.error(`查询错误日志失败 [${range}]:`, error);
      return [];
    }
  }

  /**
   * 清理过期错误日志
   */
  async cleanupErrorLogs(retentionDays: number = 30): Promise<number> {
    try {
      const cutoffTimestamp = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

      const response = await this.supabaseHttpClient.delete(`/${this.TABLE_ERROR_LOGS}`, {
        params: {
          timestamp: `lt.${cutoffTimestamp}`,
        },
        headers: {
          Prefer: 'count=exact',
        },
      });

      const contentRange = response.headers?.['content-range'];
      let deletedCount = 0;
      if (contentRange) {
        const match = contentRange.match(/\d+-\d+\/(\d+)/);
        if (match) {
          deletedCount = parseInt(match[1], 10);
        }
      }

      if (deletedCount > 0) {
        this.logger.log(`✅ 错误日志清理完成: 删除 ${deletedCount} 条 ${retentionDays} 天前的记录`);
      }
      return deletedCount;
    } catch (error) {
      this.logger.error('清理错误日志失败:', error);
      return 0;
    }
  }

  // ========================================
  // 用户活跃数据
  // ========================================

  /**
   * 保存消息处理记录（委托给 MessageProcessingRepository）
   */
  async saveMessageProcessingRecord(record: any): Promise<void> {
    // 委托给 MessageProcessingRepository
    await this.messageProcessingRepository.saveMessageProcessingRecord(record);
  }

  /**
   * 获取今日活跃用户
   */
  async getTodayActiveUsers(): Promise<any[]> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartISO = todayStart.toISOString();

    try {
      const response = await this.supabaseHttpClient.get<any[]>('/message_processing_records', {
        params: {
          select: 'user_id,user_name,chat_id,received_at,token_usage,status',
          and: `(received_at.gte.${todayStartISO},status.eq.success)`,
          order: 'received_at.asc',
        },
      });

      if (!response.data || response.data.length === 0) {
        return [];
      }

      // 按 user_id 聚合数据
      const userMap = new Map<
        string,
        {
          userId: string;
          userName: string;
          chatId: string;
          messageCount: number;
          tokenUsage: number;
          firstActiveAt: number;
          lastActiveAt: number;
        }
      >();

      for (const row of response.data) {
        const userId = row.user_id;
        if (!userId) continue;

        const receivedAt = new Date(row.received_at).getTime();
        const tokenUsage = row.token_usage || 0;

        if (!userMap.has(userId)) {
          userMap.set(userId, {
            userId,
            userName: row.user_name || '',
            chatId: row.chat_id,
            messageCount: 1,
            tokenUsage,
            firstActiveAt: receivedAt,
            lastActiveAt: receivedAt,
          });
        } else {
          const user = userMap.get(userId)!;
          user.messageCount++;
          user.tokenUsage += tokenUsage;
          user.lastActiveAt = Math.max(user.lastActiveAt, receivedAt);
        }
      }

      // 按最后活跃时间倒序排列（最近活跃的在前）
      return Array.from(userMap.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    } catch (error) {
      this.logger.error('获取今日活跃用户失败:', error);
      return [];
    }
  }

  /**
   * 获取指定日期的活跃用户
   */
  async getActiveUsersByDate(date: string): Promise<any[]> {
    try {
      // 验证日期格式 (YYYY-MM-DD)
      const datePattern = /^\d{4}-\d{2}-\d{2}$/;
      if (!datePattern.test(date)) {
        this.logger.warn(`无效的日期格式 [${date}]，应为 YYYY-MM-DD`);
        return [];
      }

      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);

      const startISO = startDate.toISOString();
      const endISO = endDate.toISOString();

      const response = await this.supabaseHttpClient.get<any[]>('/message_processing_records', {
        params: {
          select: 'user_id,user_name,chat_id,received_at,token_usage,status',
          and: `(received_at.gte.${startISO},received_at.lte.${endISO},status.eq.success)`,
          order: 'received_at.asc',
        },
      });

      if (!response.data || response.data.length === 0) {
        return [];
      }

      // 按 user_id 聚合数据
      const userMap = new Map<
        string,
        {
          userId: string;
          userName: string;
          chatId: string;
          messageCount: number;
          tokenUsage: number;
          firstActiveAt: number;
          lastActiveAt: number;
        }
      >();

      for (const row of response.data) {
        const userId = row.user_id;
        if (!userId) continue;

        const receivedAt = new Date(row.received_at).getTime();
        const tokenUsage = row.token_usage || 0;

        if (!userMap.has(userId)) {
          userMap.set(userId, {
            userId,
            userName: row.user_name || '',
            chatId: row.chat_id,
            messageCount: 1,
            tokenUsage,
            firstActiveAt: receivedAt,
            lastActiveAt: receivedAt,
          });
        } else {
          const user = userMap.get(userId)!;
          user.messageCount++;
          user.tokenUsage += tokenUsage;
          user.lastActiveAt = Math.max(user.lastActiveAt, receivedAt);
        }
      }

      // 按最后活跃时间倒序排列（最近活跃的在前）
      return Array.from(userMap.values()).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    } catch (error) {
      this.logger.error(`获取指定日期活跃用户失败 [${date}]:`, error);
      return [];
    }
  }

  /**
   * 获取用户托管状态（委托给 UserHostingRepository）
   */
  async getUserHostingStatus(chatId: string): Promise<{ isPaused: boolean }> {
    const status = await this.userHostingRepository.getUserHostingStatus(chatId);
    return { isPaused: status.isPaused };
  }

  /**
   * 保存用户活跃记录到 user_activity 表（聚合表）
   */
  async saveUserActivity(data: {
    chatId: string;
    userId?: string;
    userName?: string;
    groupId?: string;
    groupName?: string;
    messageCount: number;
    tokenUsage: number;
    activeAt: number;
  }): Promise<void> {
    try {
      await this.userHostingRepository.upsertUserActivity({
        chatId: data.chatId,
        odId: data.userId,
        odName: data.userName,
        groupId: data.groupId,
        groupName: data.groupName,
        messageCount: data.messageCount,
        totalTokens: data.tokenUsage,
        activeAt: new Date(data.activeAt),
      });
      this.logger.debug(`[user_activity] 已更新用户活跃记录: ${data.chatId}`);
    } catch (error) {
      this.logger.error(`[user_activity] 保存用户活跃记录失败 [${data.chatId}]:`, error);
      // 不抛出异常，避免影响主流程
    }
  }

  /**
   * 获取每日用户统计
   */
  async getDailyUserStats(startDate: Date, endDate: Date): Promise<any[]> {
    try {
      const startISO = startDate.toISOString();
      const endISO = endDate.toISOString();

      // 查询时间范围内的所有成功消息
      const response = await this.supabaseHttpClient.get<any[]>('/message_processing_records', {
        params: {
          select: 'user_id,received_at,token_usage',
          and: `(received_at.gte.${startISO},received_at.lte.${endISO},status.eq.success)`,
          order: 'received_at.asc',
        },
      });

      if (!response.data || response.data.length === 0) {
        return [];
      }

      // 按日期聚合用户数据
      const dailyStats = new Map<
        string,
        {
          date: string;
          uniqueUsers: Set<string>;
          messageCount: number;
          tokenUsage: number;
        }
      >();

      for (const row of response.data) {
        const receivedDate = new Date(row.received_at);
        const dateKey = receivedDate.toISOString().split('T')[0]; // YYYY-MM-DD

        if (!dailyStats.has(dateKey)) {
          dailyStats.set(dateKey, {
            date: dateKey,
            uniqueUsers: new Set(),
            messageCount: 0,
            tokenUsage: 0,
          });
        }

        const stats = dailyStats.get(dateKey)!;
        if (row.user_id) {
          stats.uniqueUsers.add(row.user_id);
        }
        stats.messageCount++;
        stats.tokenUsage += row.token_usage || 0;
      }

      // 转换为数组格式
      return Array.from(dailyStats.values()).map((stats) => ({
        date: stats.date,
        uniqueUsers: stats.uniqueUsers.size,
        messageCount: stats.messageCount,
        tokenUsage: stats.tokenUsage,
      }));
    } catch (error) {
      this.logger.error('获取每日用户统计失败:', error);
      return [];
    }
  }

  // ========================================
  // 辅助方法
  // ========================================

  /**
   * 根据时间范围获取截止时间
   */
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
}

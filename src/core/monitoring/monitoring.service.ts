import { Injectable, Logger } from '@nestjs/common';
import {
  DashboardData,
  MetricsData,
  MonitoringMetadata,
  TimeRange,
  TodayUser,
  HourlyStats,
  ResponseMinuteTrendPoint,
  AlertTrendPoint,
  BusinessMetricTrendPoint,
  DailyStats,
} from './interfaces/monitoring.interface';
import { MessageTrackingService } from './services/message-tracking.service';
import { DashboardStatsService } from './services/dashboard-stats.service';

/**
 * 监控服务（门面层）
 *
 * 统一对外 API，将职责委托给：
 * - MessageTrackingService: 消息生命周期追踪
 * - DashboardStatsService: Dashboard 数据聚合与统计
 *
 * 外部模块（wecom/message 等）只需依赖 MonitoringService，
 * 无需关心内部拆分细节。
 */
@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    private readonly trackingService: MessageTrackingService,
    private readonly dashboardService: DashboardStatsService,
  ) {
    this.logger.log('监控服务已启动（门面层）');
  }

  // ========================================
  // 消息生命周期追踪（委托给 MessageTrackingService）
  // ========================================

  recordMessageReceived(
    messageId: string,
    chatId: string,
    userId?: string,
    userName?: string,
    messageContent?: string,
    metadata?: MonitoringMetadata,
    managerName?: string,
  ): void {
    this.trackingService.recordMessageReceived(
      messageId,
      chatId,
      userId,
      userName,
      messageContent,
      metadata,
      managerName,
    );
  }

  recordWorkerStart(messageId: string): void {
    this.trackingService.recordWorkerStart(messageId);
  }

  recordAiStart(messageId: string): void {
    this.trackingService.recordAiStart(messageId);
  }

  recordAiEnd(messageId: string): void {
    this.trackingService.recordAiEnd(messageId);
  }

  recordSendStart(messageId: string): void {
    this.trackingService.recordSendStart(messageId);
  }

  recordSendEnd(messageId: string): void {
    this.trackingService.recordSendEnd(messageId);
  }

  recordSuccess(
    messageId: string,
    metadata?: MonitoringMetadata & { fallbackSuccess?: boolean },
  ): void {
    this.trackingService.recordSuccess(messageId, metadata);
  }

  recordFailure(
    messageId: string,
    error: string,
    metadata?: MonitoringMetadata & { fallbackSuccess?: boolean },
  ): void {
    this.trackingService.recordFailure(messageId, error, metadata);
  }

  // ========================================
  // Dashboard 数据（委托给 DashboardStatsService）
  // ========================================

  async getDashboardDataAsync(timeRange: TimeRange = 'today'): Promise<DashboardData> {
    return this.dashboardService.getDashboardDataAsync(timeRange);
  }

  async getDashboardOverviewAsync(timeRange: TimeRange = 'today'): Promise<{
    timeRange: string;
    overview: any;
    overviewDelta: any;
    dailyTrend: DailyStats[];
    tokenTrend: any[];
    businessTrend: BusinessMetricTrendPoint[];
    responseTrend: ResponseMinuteTrendPoint[];
    business: any;
    businessDelta: any;
    fallback: any;
    fallbackDelta: any;
  }> {
    return this.dashboardService.getDashboardOverviewAsync(timeRange);
  }

  async getSystemMonitoringAsync(): Promise<{
    queue: any;
    alertsSummary: any;
    alertTrend: AlertTrendPoint[];
  }> {
    return this.dashboardService.getSystemMonitoringAsync();
  }

  async getTrendsDataAsync(timeRange: TimeRange = 'today'): Promise<{
    dailyTrend: { hourly: HourlyStats[] };
    responseTrend: ResponseMinuteTrendPoint[];
    alertTrend: AlertTrendPoint[];
    businessTrend: BusinessMetricTrendPoint[];
  }> {
    return this.dashboardService.getTrendsDataAsync(timeRange);
  }

  async getMetricsDataAsync(): Promise<MetricsData> {
    return this.dashboardService.getMetricsDataAsync();
  }

  async getMessageStatsAsync(
    startTime: number,
    endTime: number,
  ): Promise<{ total: number; success: number; failed: number; avgDuration: number }> {
    return this.dashboardService.getMessageStatsAsync(startTime, endTime);
  }

  // ========================================
  // 用户数据（委托给 DashboardStatsService）
  // ========================================

  async getTodayUsers(): Promise<TodayUser[]> {
    return this.dashboardService.getTodayUsers();
  }

  async getTodayUsersFromDatabase(): Promise<TodayUser[]> {
    return this.dashboardService.getTodayUsersFromDatabase();
  }

  async getUsersByDate(date: string): Promise<TodayUser[]> {
    return this.dashboardService.getUsersByDate(date);
  }

  async getUserTrend(): Promise<Array<{ date: string; userCount: number; messageCount: number }>> {
    return this.dashboardService.getUserTrend();
  }
}

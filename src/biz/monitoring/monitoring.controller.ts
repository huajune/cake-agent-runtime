import { Body, Controller, Get, Logger, Query, Post, HttpCode } from '@nestjs/common';
import { AnalyticsDashboardService } from './services/dashboard/analytics-dashboard.service';
import { AnalyticsQueryService } from './services/dashboard/analytics-query.service';
import { AnalyticsMaintenanceService } from './services/maintenance/analytics-maintenance.service';
import { MonitoringCacheService } from './services/tracking/monitoring-cache.service';
import { MessageTrackingService } from './services/tracking/message-tracking.service';
import { MetricsData, TimeRange } from './types/analytics.types';
import { DeliverySkipReason } from '@shared-types/tracking.types';

/**
 * Analytics API 控制器
 * 提供 Dashboard 概览、System 监控、趋势数据、指标等接口
 */
@Controller('analytics')
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(
    private readonly dashboardService: AnalyticsDashboardService,
    private readonly queryService: AnalyticsQueryService,
    private readonly maintenanceService: AnalyticsMaintenanceService,
  ) {}

  /**
   * 获取 Dashboard 概览数据
   * GET /analytics/dashboard/overview?range=today|week|month
   */
  @Get('dashboard/overview')
  async getDashboardOverview(@Query('range') range?: TimeRange) {
    const timeRange = range || 'today';
    this.logger.debug(`获取 Dashboard 概览: ${timeRange}`);
    return this.dashboardService.getDashboardOverviewAsync(timeRange);
  }

  /**
   * 获取 System 运行状态数据
   * GET /analytics/dashboard/system
   */
  @Get('dashboard/system')
  async getSystemMonitoring() {
    this.logger.debug('获取 System 监控数据');
    return this.queryService.getSystemMonitoringAsync();
  }

  /**
   * 获取趋势数据
   * GET /analytics/stats/trends?range=today|week|month
   */
  @Get('stats/trends')
  async getTrends(@Query('range') range?: TimeRange) {
    const timeRange = range || 'today';
    this.logger.debug(`获取趋势数据: ${timeRange}`);
    return this.queryService.getTrendsDataAsync(timeRange);
  }

  /**
   * 获取详细指标数据
   * GET /analytics/metrics
   */
  @Get('metrics')
  async getMetrics(): Promise<MetricsData> {
    return this.queryService.getMetricsDataAsync();
  }

  /**
   * 获取活跃用户
   * GET /analytics/users?date=YYYY-MM-DD
   */
  @Get('users')
  async getUsersByDate(@Query('date') date?: string) {
    if (!date) {
      return this.queryService.getTodayUsersFromDatabase();
    }
    return this.queryService.getUsersByDate(date);
  }

  /**
   * 获取咨询用户趋势数据
   * GET /analytics/user-trend
   */
  @Get('user-trend')
  async getUserTrend() {
    return this.queryService.getUserTrend();
  }

  /**
   * 获取最近消息
   * GET /analytics/recent-messages
   */
  @Get('recent-messages')
  async getRecentMessages(@Query('limit') limit?: string) {
    const limitNum = parseInt(limit || '50', 10);
    return this.queryService.getRecentDetailRecords(limitNum);
  }

  /**
   * 获取系统状态信息
   * GET /analytics/system
   */
  @Get('system')
  async getSystemInfo() {
    return this.queryService.getSystemInfo();
  }

  /**
   * 清空所有监控统计数据
   * POST /analytics/clear
   */
  @Post('clear')
  @HttpCode(200)
  async clearAllData() {
    this.logger.log('手动触发清空所有监控统计数据');
    await this.maintenanceService.clearAllDataAsync();
    return { success: true, message: '监控统计数据已清空' };
  }

  /**
   * 清除指定类型的缓存
   * POST /analytics/cache/clear?type=all|metrics|history|agent
   */
  @Post('cache/clear')
  @HttpCode(200)
  async clearCache(@Query('type') type?: 'all' | 'metrics' | 'history' | 'agent') {
    const cacheType = type || 'all';
    this.logger.log(`手动触发清除缓存: ${cacheType}`);
    await this.maintenanceService.clearCacheAsync(cacheType);
    return { success: true, message: `缓存 [${cacheType}] 已清除` };
  }
}

/**
 * Monitoring 兼容出口。
 * Dashboard 历史验收脚本使用 /monitoring/*，这里保留轻量别名并直接暴露全局计数器。
 */
@Controller('monitoring')
export class MonitoringController {
  private readonly logger = new Logger(MonitoringController.name);

  constructor(
    private readonly dashboardService: AnalyticsDashboardService,
    private readonly cacheService: MonitoringCacheService,
    private readonly messageTrackingService: MessageTrackingService,
  ) {}

  /**
   * GET /monitoring/dashboard?range=today|week|month
   */
  @Get('dashboard')
  async getMonitoringDashboard(@Query('range') range?: TimeRange) {
    const timeRange = range || 'today';
    const [dashboard, globalCounters] = await Promise.all([
      this.dashboardService.getDashboardOverviewAsync(timeRange),
      this.cacheService.getCounters(),
    ]);

    return {
      ...dashboard,
      globalCounters,
      totalOutputLeakSkipped: globalCounters.totalOutputLeakSkipped,
      totalSameBrandCollapseSkipped: globalCounters.totalSameBrandCollapseSkipped,
    };
  }

  /**
   * GET /monitoring/global-counters
   */
  @Get('global-counters')
  async getGlobalCounters() {
    return this.cacheService.getCounters();
  }

  /**
   * POST /monitoring/global-counters/probe-skip
   *
   * 本地验收用：模拟投递层静默丢弃事件，验证 counter 可见且会增长。
   */
  @Post('global-counters/probe-skip')
  @HttpCode(200)
  async probeReplySkipped(@Body() body?: { messageId?: string; reason?: DeliverySkipReason }) {
    const reason: DeliverySkipReason =
      body?.reason === 'same_brand_collapse' ? 'same_brand_collapse' : 'output_leak';
    const messageId = body?.messageId?.trim() || `monitoring-probe-${Date.now()}`;

    this.logger.warn(
      `[MonitoringProbe] recordReplySkipped messageId=${messageId} reason=${reason}`,
    );
    this.messageTrackingService.recordReplySkipped(messageId, reason);

    return this.cacheService.getCounters();
  }
}

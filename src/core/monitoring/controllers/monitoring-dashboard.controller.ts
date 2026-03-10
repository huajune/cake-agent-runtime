import { Controller, Get, Logger, Query } from '@nestjs/common';
import { MonitoringService } from '../monitoring.service';
import { DashboardData, MetricsData, TimeRange } from '../interfaces/monitoring.interface';

/**
 * Dashboard 监控控制器
 * 提供 Dashboard 概览、System 监控、趋势数据、指标、健康检查等接口
 */
@Controller('monitoring')
export class MonitoringDashboardController {
  private readonly logger = new Logger(MonitoringDashboardController.name);

  constructor(private readonly monitoringService: MonitoringService) {}

  /**
   * 获取仪表盘数据（完整版，已废弃）
   * @deprecated 建议使用 /monitoring/dashboard/overview
   */
  @Get('dashboard')
  async getDashboard(@Query('range') range?: TimeRange): Promise<DashboardData> {
    const timeRange = range || 'today';
    this.logger.warn(
      `[已废弃] /monitoring/dashboard 接口已废弃，建议使用专用接口: /dashboard/overview 或 /dashboard/system`,
    );
    return this.monitoringService.getDashboardDataAsync(timeRange);
  }

  /**
   * 获取 Dashboard 概览数据（轻量级）
   * GET /monitoring/dashboard/overview?range=today|week|month
   */
  @Get('dashboard/overview')
  async getDashboardOverview(@Query('range') range?: TimeRange) {
    const timeRange = range || 'today';
    this.logger.debug(`获取 Dashboard 概览: ${timeRange}`);
    return this.monitoringService.getDashboardOverviewAsync(timeRange);
  }

  /**
   * 获取 System 监控数据（轻量级）
   * GET /monitoring/dashboard/system
   */
  @Get('dashboard/system')
  async getSystemMonitoring() {
    this.logger.debug('获取 System 监控数据');
    return this.monitoringService.getSystemMonitoringAsync();
  }

  /**
   * 获取趋势数据（独立接口）
   * GET /monitoring/stats/trends?range=today|week|month
   */
  @Get('stats/trends')
  async getTrends(@Query('range') range?: TimeRange) {
    const timeRange = range || 'today';
    this.logger.debug(`获取趋势数据: ${timeRange}`);
    return this.monitoringService.getTrendsDataAsync(timeRange);
  }

  /**
   * 获取详细指标数据
   * GET /monitoring/metrics
   */
  @Get('metrics')
  async getMetrics(): Promise<MetricsData> {
    return this.monitoringService.getMetricsDataAsync();
  }

  /**
   * 健康检查
   * GET /monitoring/health
   */
  @Get('health')
  health(): { status: string; timestamp: number } {
    return { status: 'ok', timestamp: Date.now() };
  }

  /**
   * 获取指定日期的活跃用户
   * GET /monitoring/users?date=YYYY-MM-DD
   */
  @Get('users')
  async getUsersByDate(@Query('date') date?: string) {
    if (!date) {
      return this.monitoringService.getTodayUsersFromDatabase();
    }

    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(date)) {
      this.logger.warn(`无效的日期格式: ${date}`);
      return [];
    }

    return this.monitoringService.getUsersByDate(date);
  }

  /**
   * 获取近1月咨询用户趋势数据
   * GET /monitoring/user-trend
   */
  @Get('user-trend')
  async getUserTrend() {
    return this.monitoringService.getUserTrend();
  }
}

import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BusinessMetricRuleEngine } from '@analytics/rules/business-metric-rule.engine';
import { AnalyticsDashboardService } from '../dashboard/analytics-dashboard.service';
import { AgentReplyConfig } from '@biz/hosting-config/types/hosting-config.types';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { AlertLevel } from '@enums/alert.enum';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';

/**
 * 业务指标告警服务
 *
 * 定期检查业务指标 (成功率、响应时间、队列、错误率)，发现异常时通过飞书告警
 */
@Injectable()
export class AnalyticsAlertService implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsAlertService.name);

  // ===== 可配置项（从 Supabase 读取） =====
  private enabled = true;
  private minSamples = 10;
  private alertIntervalMinutes = 30;

  // ===== 告警阈值 =====
  private thresholds = {
    successRateCritical: 80,
    avgDurationCritical: 60000,
    queueDepthCritical: 20,
    errorRateCritical: 10,
  };

  private lastAlertTimestamps = new Map<string, number>();

  constructor(
    private readonly analyticsDashboardService: AnalyticsDashboardService,
    private readonly alertService: AlertNotifierService,
    private readonly businessMetricRuleEngine: BusinessMetricRuleEngine,
    private readonly systemConfigService: SystemConfigService,
    @Optional()
    private readonly exceptionNotifier?: IncidentReporterService,
  ) {
    this.systemConfigService.onAgentReplyConfigChange((config) => {
      this.onConfigChange(config);
    });
  }

  async onModuleInit() {
    try {
      const config = await this.systemConfigService.getAgentReplyConfig();
      this.applyConfig(config);
      this.logger.log(
        `业务指标告警服务已启动: 启用=${this.enabled}, 告警间隔=${this.alertIntervalMinutes}min`,
      );
    } catch (error) {
      this.logger.warn('从 Supabase 加载告警配置失败，使用默认值');
    }
  }

  private applyConfig(config: AgentReplyConfig): void {
    this.enabled = config.businessAlertEnabled ?? true;
    this.minSamples = config.minSamplesForAlert ?? 10;
    this.alertIntervalMinutes = config.alertIntervalMinutes ?? 30;

    if (config.successRateCritical !== undefined) {
      this.thresholds.successRateCritical = config.successRateCritical;
    }
    if (config.avgDurationCritical !== undefined) {
      this.thresholds.avgDurationCritical = config.avgDurationCritical;
    }
    if (config.queueDepthCritical !== undefined) {
      this.thresholds.queueDepthCritical = config.queueDepthCritical;
    }
    if (config.errorRateCritical !== undefined) {
      this.thresholds.errorRateCritical = config.errorRateCritical;
    }
  }

  private onConfigChange(config: AgentReplyConfig): void {
    this.applyConfig(config);
    this.logger.log('业务指标告警配置已更新');
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkBusinessMetrics(): Promise<void> {
    if (!this.enabled) return;

    try {
      const dashboard = await this.analyticsDashboardService.getDashboardDataAsync('today');
      const alerts = this.businessMetricRuleEngine.evaluate({
        snapshot: {
          totalMessages: dashboard.overview.totalMessages,
          successRate: dashboard.overview.successRate,
          avgDuration: dashboard.overview.avgDuration,
          currentProcessing: dashboard.queue.currentProcessing,
          errorCountLast24Hours: dashboard.alertsSummary.last24Hours,
        },
        minSamples: this.minSamples,
        thresholds: this.thresholds,
      });

      for (const alert of alerts) {
        if (!this.shouldSendAlert(alert.key)) continue;
        await this.alertService.sendSimpleAlert(alert.title, alert.message, alert.level);
        this.recordAlertSent(alert.key);
      }
    } catch (error) {
      this.logger.error(`业务指标检查失败: ${error.message}`);
      this.exceptionNotifier?.notifyAsync({
        source: {
          subsystem: 'monitoring',
          component: 'AnalyticsAlertService',
          action: 'checkBusinessMetrics',
          trigger: 'cron',
        },
        code: 'cron.job_failed',
        summary: '业务指标告警任务失败',
        error,
        severity: AlertLevel.ERROR,
      });
    }
  }

  private shouldSendAlert(key: string): boolean {
    const lastTime = this.lastAlertTimestamps.get(key);
    if (!lastTime) return true;
    const minIntervalMs = this.alertIntervalMinutes * 60 * 1000;
    return Date.now() - lastTime > minIntervalMs;
  }

  private recordAlertSent(key: string): void {
    this.lastAlertTimestamps.set(key, Date.now());
  }
}

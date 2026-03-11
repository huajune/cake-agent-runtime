import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnalyticsService } from './analytics.service';
import { FeishuAlertService } from '@core/feishu';
import { AgentReplyConfig } from '@db';
import { SystemConfigService } from '@biz/hosting-config';

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
    private readonly analyticsService: AnalyticsService,
    private readonly feishuAlertService: FeishuAlertService,
    private readonly systemConfigService: SystemConfigService,
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
      const dashboard = await this.analyticsService.getDashboardDataAsync('today');
      const totalMessages = dashboard.overview.totalMessages;

      if (totalMessages >= this.minSamples) {
        await this.checkSuccessRate(dashboard.overview.successRate, totalMessages);
        await this.checkAvgDuration(dashboard.overview.avgDuration, totalMessages);
      }

      await this.checkQueueDepth(dashboard.queue.currentProcessing);
      await this.checkErrorRate(dashboard.alertsSummary.last24Hours);
    } catch (error) {
      this.logger.error(`业务指标检查失败: ${error.message}`);
    }
  }

  private async checkSuccessRate(currentValue: number, totalMessages: number): Promise<void> {
    const critical = this.thresholds.successRateCritical;
    const warning = critical + 10;
    const key = 'success-rate';

    if (!Number.isFinite(currentValue)) return;

    if (currentValue < critical) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '成功率严重下降',
          `当前成功率: ${currentValue.toFixed(1)}%\n阈值: ${critical}%\n今日消息数: ${totalMessages}`,
          'critical',
        );
        this.recordAlertSent(key);
      }
    } else if (currentValue < warning) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '成功率下降',
          `当前成功率: ${currentValue.toFixed(1)}%\n阈值: ${warning}%\n今日消息数: ${totalMessages}`,
          'warning',
        );
        this.recordAlertSent(key);
      }
    }
  }

  private async checkAvgDuration(currentValue: number, totalMessages: number): Promise<void> {
    const critical = this.thresholds.avgDurationCritical;
    const warning = Math.floor(critical / 2);
    const key = 'avg-duration';

    if (!Number.isFinite(currentValue) || currentValue <= 0) return;

    if (currentValue > critical) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '响应时间过长',
          `当前平均响应: ${(currentValue / 1000).toFixed(1)}s\n阈值: ${critical / 1000}s\n今日消息数: ${totalMessages}`,
          'critical',
        );
        this.recordAlertSent(key);
      }
    } else if (currentValue > warning) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '响应时间偏高',
          `当前平均响应: ${(currentValue / 1000).toFixed(1)}s\n阈值: ${warning / 1000}s\n今日消息数: ${totalMessages}`,
          'warning',
        );
        this.recordAlertSent(key);
      }
    }
  }

  private async checkQueueDepth(currentValue: number): Promise<void> {
    const critical = this.thresholds.queueDepthCritical;
    const warning = Math.floor(critical / 2);
    const key = 'queue-depth';

    if (currentValue > critical) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '队列严重积压',
          `当前队列深度: ${currentValue}条\n阈值: ${critical}条`,
          'critical',
        );
        this.recordAlertSent(key);
      }
    } else if (currentValue > warning) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '队列积压',
          `当前队列深度: ${currentValue}条\n阈值: ${warning}条`,
          'warning',
        );
        this.recordAlertSent(key);
      }
    }
  }

  private async checkErrorRate(errorCount: number): Promise<void> {
    const critical = this.thresholds.errorRateCritical;
    const warning = Math.floor(critical / 2);
    const key = 'error-rate';
    const hourlyRate = errorCount / 24;

    if (hourlyRate > critical) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '错误率过高',
          `24h错误数: ${errorCount}\n平均: ${hourlyRate.toFixed(1)}/h\n阈值: ${critical}/h`,
          'critical',
        );
        this.recordAlertSent(key);
      }
    } else if (hourlyRate > warning) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '错误率偏高',
          `24h错误数: ${errorCount}\n平均: ${hourlyRate.toFixed(1)}/h\n阈值: ${warning}/h`,
          'warning',
        );
        this.recordAlertSent(key);
      }
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

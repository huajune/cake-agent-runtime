import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MonitoringService } from './monitoring.service';
import { FeishuAlertService } from '@core/feishu';
import { AgentReplyConfig } from '@supabase';
import { SystemConfigService } from '@supabase/config';

/**
 * 监控告警服务（简化版）
 *
 * 定期检查业务指标，发现异常时主动告警
 * 阈值硬编码，仅支持配置开关、最小样本量和告警间隔
 *
 * 触发条件：
 * - 成功率告警：今日消息数 >= minSamples 且成功率低于阈值
 * - 响应时间告警：今日消息数 >= minSamples 且平均响应时间高于阈值
 * - 队列积压告警：当前队列深度高于阈值
 * - 错误率告警：24 小时错误数高于阈值
 */
@Injectable()
export class MonitoringAlertService implements OnModuleInit {
  private readonly logger = new Logger(MonitoringAlertService.name);

  // ===== 可配置项（从 Supabase 读取） =====
  private enabled = true; // 是否启用业务指标告警
  private minSamples = 10; // 最小样本量
  private alertIntervalMinutes = 30; // 同类告警最小间隔（分钟）

  // ===== 告警阈值（可动态配置） =====
  private thresholds = {
    // 成功率（百分比）- warning 为 critical + 10
    successRateCritical: 80,
    // 响应时间（毫秒）- warning 为 critical / 2
    avgDurationCritical: 60000, // 60 秒
    // 队列深度（条数）- warning 为 critical / 2
    queueDepthCritical: 20,
    // 错误率（每小时）- warning 为 critical / 2
    errorRateCritical: 10,
  };

  // 状态追踪（避免重复告警）
  private lastAlertTimestamps = new Map<string, number>();

  constructor(
    private readonly monitoringService: MonitoringService,
    private readonly feishuAlertService: FeishuAlertService,
    private readonly systemConfigService: SystemConfigService,
  ) {
    // 注册配置变更回调
    this.systemConfigService.onAgentReplyConfigChange((config) => {
      this.onConfigChange(config);
    });
  }

  /**
   * 模块初始化：从 Supabase 加载配置
   */
  async onModuleInit() {
    try {
      const config = await this.systemConfigService.getAgentReplyConfig();
      this.applyConfig(config);
      this.logger.log(
        `业务指标告警配置: 启用=${this.enabled}, 最小样本=${this.minSamples}, 告警间隔=${this.alertIntervalMinutes}分钟`,
      );
    } catch (error) {
      this.logger.warn('从 Supabase 加载告警配置失败，使用默认值');
    }
  }

  /**
   * 应用配置
   */
  private applyConfig(config: AgentReplyConfig): void {
    this.enabled = config.businessAlertEnabled ?? true;
    this.minSamples = config.minSamplesForAlert ?? 10;
    this.alertIntervalMinutes = config.alertIntervalMinutes ?? 30;

    // 应用告警阈值配置
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

  /**
   * 配置变更回调
   */
  private onConfigChange(config: AgentReplyConfig): void {
    const oldEnabled = this.enabled;
    const oldMinSamples = this.minSamples;
    const oldInterval = this.alertIntervalMinutes;

    this.applyConfig(config);

    // 检查是否有变化
    if (
      oldEnabled !== this.enabled ||
      oldMinSamples !== this.minSamples ||
      oldInterval !== this.alertIntervalMinutes
    ) {
      this.logger.log(
        `业务指标告警配置已更新: 启用=${this.enabled}, 最小样本=${this.minSamples}, 告警间隔=${this.alertIntervalMinutes}分钟`,
      );
    }
  }

  /**
   * 每 5 分钟检查一次业务指标
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkBusinessMetrics(): Promise<void> {
    // 如果告警已禁用，直接返回
    if (!this.enabled) {
      return;
    }

    try {
      const dashboard = await this.monitoringService.getDashboardDataAsync('today');
      const totalMessages = dashboard.overview.totalMessages;

      // 1. 成功率告警（需要足够样本量）
      if (totalMessages >= this.minSamples) {
        await this.checkSuccessRate(dashboard.overview.successRate, totalMessages);
      }

      // 2. 响应时间告警（需要足够样本量）
      if (totalMessages >= this.minSamples) {
        await this.checkAvgDuration(dashboard.overview.avgDuration, totalMessages);
      }

      // 3. 队列积压告警（实时指标，无需样本量）
      await this.checkQueueDepth(dashboard.queue.currentProcessing);

      // 4. 错误率告警（累计指标）
      await this.checkErrorRate(dashboard.alertsSummary.last24Hours);
    } catch (error) {
      this.logger.error(`业务指标检查失败: ${error.message}`);
    }
  }

  /**
   * 检查成功率
   */
  private async checkSuccessRate(currentValue: number, totalMessages: number): Promise<void> {
    const critical = this.thresholds.successRateCritical;
    const warning = critical + 10; // warning 比 critical 高 10%
    const key = 'success-rate';

    // NaN 或无效值不触发告警
    if (!Number.isFinite(currentValue)) {
      return;
    }

    if (currentValue < critical) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '成功率严重下降',
          `当前成功率: ${currentValue.toFixed(1)}%\n阈值: ${critical}%\n今日消息数: ${totalMessages}\n建议: 立即检查 Agent API 状态`,
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

  /**
   * 检查响应时间
   */
  private async checkAvgDuration(currentValue: number, totalMessages: number): Promise<void> {
    const critical = this.thresholds.avgDurationCritical;
    const warning = Math.floor(critical / 2); // warning 为 critical 的一半
    const key = 'avg-duration';

    // NaN 或无效值不触发告警
    if (!Number.isFinite(currentValue) || currentValue <= 0) {
      return;
    }

    if (currentValue > critical) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '响应时间过长',
          `当前平均响应: ${(currentValue / 1000).toFixed(1)}秒\n阈值: ${critical / 1000}秒\n今日消息数: ${totalMessages}\n建议: 检查 Agent API 性能`,
          'critical',
        );
        this.recordAlertSent(key);
      }
    } else if (currentValue > warning) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '响应时间偏高',
          `当前平均响应: ${(currentValue / 1000).toFixed(1)}秒\n阈值: ${warning / 1000}秒\n今日消息数: ${totalMessages}`,
          'warning',
        );
        this.recordAlertSent(key);
      }
    }
  }

  /**
   * 检查队列深度
   */
  private async checkQueueDepth(currentValue: number): Promise<void> {
    const critical = this.thresholds.queueDepthCritical;
    const warning = Math.floor(critical / 2); // warning 为 critical 的一半
    const key = 'queue-depth';

    if (currentValue > critical) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '队列严重积压',
          `当前队列深度: ${currentValue}条\n阈值: ${critical}条\n建议: 检查消息处理速度`,
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

  /**
   * 检查错误率
   */
  private async checkErrorRate(errorCount: number): Promise<void> {
    const critical = this.thresholds.errorRateCritical;
    const warning = Math.floor(critical / 2); // warning 为 critical 的一半
    const key = 'error-rate';

    // 将 24 小时错误数转换为每小时平均
    const hourlyRate = errorCount / 24;

    if (hourlyRate > critical) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '错误率过高',
          `24小时错误数: ${errorCount}次\n每小时平均: ${hourlyRate.toFixed(1)}次\n阈值: ${critical}次/小时`,
          'critical',
        );
        this.recordAlertSent(key);
      }
    } else if (hourlyRate > warning) {
      if (this.shouldSendAlert(key)) {
        await this.feishuAlertService.sendSimpleAlert(
          '错误率偏高',
          `24小时错误数: ${errorCount}次\n每小时平均: ${hourlyRate.toFixed(1)}次\n阈值: ${warning}次/小时`,
          'warning',
        );
        this.recordAlertSent(key);
      }
    }
  }

  /**
   * 检查是否应该发送告警（避免频繁告警）
   */
  private shouldSendAlert(key: string): boolean {
    const lastTime = this.lastAlertTimestamps.get(key);
    if (!lastTime) return true;
    // 使用动态配置的告警间隔（分钟转毫秒）
    const minIntervalMs = this.alertIntervalMinutes * 60 * 1000;
    return Date.now() - lastTime > minIntervalMs;
  }

  /**
   * 记录告警发送时间
   */
  private recordAlertSent(key: string): void {
    this.lastAlertTimestamps.set(key, Date.now());
  }
}

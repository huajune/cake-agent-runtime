import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BusinessMetricRuleEngine } from '@analytics/rules/business-metric-rule.engine';
import { AnalyticsDashboardService } from '../dashboard/analytics-dashboard.service';
import { AgentReplyConfig } from '@biz/hosting-config/types/hosting-config.types';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { AlertLevel } from '@enums/alert.enum';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import { AgentExecutionEventRepository } from '../../repositories/agent-execution-event.repository';

export interface ExtractionDropRateCheckResult {
  currentDate: string;
  currentCount: number;
  previousDate: string;
  previousCount: number;
  doubled: boolean;
  absoluteExceeded: boolean;
  wouldAlert: boolean;
  dryRun: boolean;
}

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
    private readonly configService: ConfigService,
    @Optional()
    private readonly exceptionNotifier?: IncidentReporterService,
    @Optional()
    private readonly agentEventRepository?: AgentExecutionEventRepository,
  ) {
    this.systemConfigService.onAgentReplyConfigChange((config) => {
      this.onConfigChange(config);
    });
  }

  async onModuleInit() {
    if (this.isReadOnlyPreview()) {
      this.enabled = false;
      this.logger.warn('READ_ONLY_PREVIEW=true，业务指标告警服务已禁用');
      return;
    }

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
    if (this.isReadOnlyPreview()) return;
    if (!this.enabled) return;

    try {
      const dashboard = await this.analyticsDashboardService.getDashboardDataAsync('today');
      const alerts = this.businessMetricRuleEngine.evaluate({
        snapshot: {
          totalMessages: dashboard.overview.totalMessages,
          successRate: dashboard.overview.successRate,
          avgDuration: dashboard.overview.avgDuration,
          activeRequests: dashboard.queue.activeRequests,
          errorCountLastHour: dashboard.alertsSummary.lastHour,
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

  /**
   * 每日 00:20（CST）比较前两个完整自然日的 extraction_field_dropped 数量。
   * dryRun 只返回判定、不发通知，供发版前验收与运维探针复用。
   */
  @Cron('20 0 * * *', { timeZone: 'Asia/Shanghai' })
  async checkExtractionDropRate(
    options: { dryRun?: boolean; now?: Date } = {},
  ): Promise<ExtractionDropRateCheckResult | null> {
    if (this.isReadOnlyPreview() || !this.agentEventRepository) return null;

    const todayStart = this.startOfShanghaiDay(options.now ?? new Date());
    const currentFrom = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
    const previousFrom = new Date(currentFrom.getTime() - 24 * 60 * 60 * 1000);
    try {
      const [currentCount, previousCount] = await Promise.all([
        this.agentEventRepository.countEventsByTypeBetween(
          'extraction_field_dropped',
          currentFrom,
          todayStart,
        ),
        this.agentEventRepository.countEventsByTypeBetween(
          'extraction_field_dropped',
          previousFrom,
          currentFrom,
        ),
      ]);
      const doubled = previousCount > 0 && currentCount >= previousCount * 2;
      const absoluteExceeded = currentCount > 800;
      const result: ExtractionDropRateCheckResult = {
        currentDate: this.formatShanghaiDate(currentFrom),
        currentCount,
        previousDate: this.formatShanghaiDate(previousFrom),
        previousCount,
        doubled,
        absoluteExceeded,
        wouldAlert: doubled || absoluteExceeded,
        dryRun: options.dryRun === true,
      };

      if (!result.wouldAlert || result.dryRun) {
        this.logger.log(
          `[抽取丢弃日检${result.dryRun ? '/dry-run' : ''}] ${JSON.stringify(result)}`,
        );
        return result;
      }

      const reasons = [
        doubled ? `较前日达到 ${(currentCount / previousCount).toFixed(2)} 倍` : null,
        absoluteExceeded ? '超过绝对阈值 800' : null,
      ].filter(Boolean);
      await this.alertService.sendSimpleAlert(
        '抽取字段丢弃量异常',
        [
          `统计日：${result.currentDate}（CST）`,
          `当日 extraction_field_dropped：${currentCount}`,
          `前日（${result.previousDate}）：${previousCount}`,
          `触发条件：${reasons.join('；')}`,
          '',
          '请按 modelId 与 rawOutput 采样排查模型切换、供应商串请求或提示词指令遵循劣化。',
        ].join('\n'),
        AlertLevel.ERROR,
      );
      return result;
    } catch (error) {
      this.logger.error(`抽取字段丢弃日检失败: ${toErrorMessage(error)}`);
      return null;
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

  private isReadOnlyPreview(): boolean {
    return this.configService.get<string>('READ_ONLY_PREVIEW', 'false') === 'true';
  }

  private startOfShanghaiDay(date: Date): Date {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const read = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value);
    return new Date(Date.UTC(read('year'), read('month') - 1, read('day')) - 8 * 60 * 60 * 1000);
  }

  private formatShanghaiDate(date: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }
}

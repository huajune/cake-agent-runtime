import { Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Environment } from '@enums/environment.enum';
import { FEISHU_RECEIVER_USERS, type FeishuReceiver } from '@infra/feishu/constants/receivers';
import { ALERT_THROTTLE } from '@infra/feishu/constants/constants';
import { AlertLevel } from '@enums/alert.enum';
import { FeishuAlertChannel } from '../channels/feishu-alert.channel';
import { AlertCardRenderer } from '../renderers/alert-card.renderer';
import { AlertContext } from '../types/alert.types';
import {
  ALERT_LOG_PERSISTER,
  type AlertLogPersister,
} from '../types/alert-log-persister.interface';

/** sendAlert 选项：persist=false 用于已由 recordFailure 落库的消息失败路径，避免双写。 */
export interface SendAlertOptions {
  persist?: boolean;
}

interface ThrottleState {
  count: number;
  firstSeen: number;
  lastSent: number;
}

@Injectable()
export class AlertNotifierService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AlertNotifierService.name);
  private readonly throttleWindowMs = ALERT_THROTTLE.WINDOW_MS;
  private readonly throttleMaxCount = ALERT_THROTTLE.MAX_COUNT;
  private readonly throttleMap = new Map<string, ThrottleState>();
  private hasWarnedNonProdSuppression = false;
  // 不能在构造器注入 ALERT_LOG_PERSISTER：token 由 @Global MonitoringModule 提供，
  // 而 MonitoringModule 又 imports NotificationModule，构造期注入会形成
  // provider 级循环依赖，Nest 实例加载静默死锁（v5.14.0 生产启动卡死事故）。
  // 改为应用装配完成后经 ModuleRef 懒解析。
  private alertLogPersister?: AlertLogPersister;

  constructor(
    private readonly alertChannel: FeishuAlertChannel,
    private readonly alertCardRenderer: AlertCardRenderer,
    private readonly moduleRef: ModuleRef,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    try {
      this.alertLogPersister = this.moduleRef.get<AlertLogPersister>(ALERT_LOG_PERSISTER, {
        strict: false,
      });
    } catch {
      // 监控模块未装配（如部分单测/工具进程）时降级为仅发送，不持久化
      this.logger.warn('ALERT_LOG_PERSISTER 未注册，告警将不写入 monitoring_error_logs');
    }
  }

  /**
   * 发送告警。无论是否节流、是否发送成功、飞书是否启用，都先持久化一条到
   * monitoring_error_logs（dashboard "今日错误" 才能看到子系统告警），
   * 持久化失败不影响发送。options.persist=false 用于消息处理失败路径
   * （已由 recordFailure→saveErrorLog 落库），避免双写重复计数。
   */
  async sendAlert(context: AlertContext, options?: SendAlertOptions): Promise<boolean> {
    const throttleKey = context.dedupe?.key || context.code;
    const feishuEnabled = this.isFeishuDeliveryEnabled();
    const willThrottle = !this.shouldSend(throttleKey);

    let delivered = false;
    let sendError: unknown;

    if (feishuEnabled && !willThrottle) {
      try {
        const card = this.alertCardRenderer.buildAlertCard(context);
        delivered = await this.alertChannel.send(card);
        if (delivered) this.recordSent(throttleKey);
      } catch (error) {
        sendError = error;
      }
    }

    if (options?.persist !== false) {
      this.persistAlertLog(context, { throttled: willThrottle, delivered });
    }

    if (sendError) {
      this.logger.error(
        `发送告警失败: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
      );
      return false;
    }
    if (willThrottle) {
      this.logger.warn(`告警被节流: ${throttleKey}`);
    }
    return delivered;
  }

  /** 把告警写入错误日志表（fire-and-forget，失败仅告警不阻塞）。 */
  private persistAlertLog(
    context: AlertContext,
    flags: { throttled: boolean; delivered: boolean },
  ): void {
    if (!this.alertLogPersister) return;
    void this.alertLogPersister
      .persist({
        messageId: context.scope?.messageId,
        timestamp: Date.now(),
        error: context.diagnostics?.errorMessage ?? context.summary ?? context.code ?? '',
        code: context.code,
        severity: context.severity,
        summary: context.summary,
        subsystem: context.source?.subsystem,
        component: context.source?.component,
        action: context.source?.action,
        dedupeKey: context.dedupe?.key,
        throttled: flags.throttled,
        delivered: flags.delivered,
      })
      .catch((err) => {
        this.logger.warn(`持久化告警日志失败: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  async sendSimpleAlert(
    title: string,
    message: string,
    level: 'info' | 'warning' | 'error' | 'critical' = 'error',
  ): Promise<boolean> {
    return this.sendAlert({
      code: 'system.notice',
      summary: title,
      severity: level as AlertLevel,
      source: {
        subsystem: 'notification',
        component: 'AlertNotifierService',
        action: 'sendSimpleAlert',
        trigger: 'manual',
      },
      diagnostics: {
        errorMessage: message,
      },
    });
  }

  createFallbackMentionAlert(context: Omit<AlertContext, 'routing'>): AlertContext {
    return this.alertCardRenderer.createFallbackMentionAlert(context);
  }

  createPromptInjectionAlert(params: {
    userId: string;
    reason: string;
    contentPreview: string;
  }): AlertContext {
    return this.alertCardRenderer.createPromptInjectionAlert(params);
  }

  createGroupFullMentionUsers(): FeishuReceiver[] {
    return this.alertCardRenderer.createGroupFullMentionUsers();
  }

  getDefaultReceivers(): FeishuReceiver[] {
    return [FEISHU_RECEIVER_USERS.GAO_YAQI];
  }

  private shouldSend(key: string): boolean {
    const now = Date.now();
    const state = this.throttleMap.get(key);

    if (!state) return true;
    if (now - state.firstSeen > this.throttleWindowMs) {
      this.throttleMap.delete(key);
      return true;
    }

    return state.count < this.throttleMaxCount;
  }

  private recordSent(key: string): void {
    const now = Date.now();
    const state = this.throttleMap.get(key);

    if (!state || now - state.firstSeen > this.throttleWindowMs) {
      this.throttleMap.set(key, {
        count: 1,
        firstSeen: now,
        lastSent: now,
      });
      return;
    }

    this.throttleMap.set(key, {
      count: state.count + 1,
      firstSeen: state.firstSeen,
      lastSent: now,
    });
  }

  private isFeishuDeliveryEnabled(): boolean {
    const nodeEnv =
      this.configService?.get<Environment>('NODE_ENV', Environment.Production) ??
      Environment.Production;
    const allowNonProd = this.parseBoolean(
      this.configService?.get<string>('FEISHU_ALERT_ALLOW_NON_PROD'),
    );

    if (nodeEnv === Environment.Production || allowNonProd) {
      return true;
    }

    if (!this.hasWarnedNonProdSuppression) {
      this.logger.warn(
        `[${nodeEnv}] 非生产环境默认不发送飞书系统告警；如需开启，请设置 FEISHU_ALERT_ALLOW_NON_PROD=true`,
      );
      this.hasWarnedNonProdSuppression = true;
    }
    return false;
  }

  private parseBoolean(value?: string): boolean {
    if (!value) {
      return false;
    }

    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
}

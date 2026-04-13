import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from '@enums/environment.enum';
import { FEISHU_RECEIVER_USERS, type FeishuReceiver } from '@infra/feishu/constants/receivers';
import { ALERT_THROTTLE } from '@infra/feishu/constants/constants';
import { AlertLevel } from '@enums/alert.enum';
import { FeishuAlertChannel } from '../channels/feishu-alert.channel';
import { AlertCardRenderer } from '../renderers/alert-card.renderer';
import { AlertContext } from '../types/alert.types';

interface ThrottleState {
  count: number;
  firstSeen: number;
  lastSent: number;
}

@Injectable()
export class AlertNotifierService {
  private readonly logger = new Logger(AlertNotifierService.name);
  private readonly throttleWindowMs = ALERT_THROTTLE.WINDOW_MS;
  private readonly throttleMaxCount = ALERT_THROTTLE.MAX_COUNT;
  private readonly throttleMap = new Map<string, ThrottleState>();
  private hasWarnedNonProdSuppression = false;

  constructor(
    private readonly alertChannel: FeishuAlertChannel,
    private readonly alertCardRenderer: AlertCardRenderer,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  async sendAlert(context: AlertContext): Promise<boolean> {
    if (!this.isFeishuDeliveryEnabled()) {
      return false;
    }

    const throttleKey = context.dedupe?.key || context.code;

    if (!this.shouldSend(throttleKey)) {
      this.logger.warn(`告警被节流: ${throttleKey}`);
      return false;
    }

    try {
      const card = this.alertCardRenderer.buildAlertCard(context);
      const success = await this.alertChannel.send(card);
      if (success) this.recordSent(throttleKey);
      return success;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`发送告警失败: ${message}`);
      return false;
    }
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
